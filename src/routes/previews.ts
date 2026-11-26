import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { canPreview, canViewFull } from '../previews/permissions.js';
import { getCurrentUser } from './auth.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';

const PDF_MIME = 'application/pdf';

interface DocFileRow {
  doc_id: string;
  status: string;
  visibility: string;
  standard_id: string | null;
  created_by: string | null;
  file_id: string | null;
  version: number | null;
  storage_path: string | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size: string | null;
  checksum_sha256: string | null;
  page_count: number | null;
  preview_path: string | null;
  preview_pages: number | null;
  preview_status: string | null;
}

async function loadDocumentWithLatestFile(pool: pg.Pool, docId: string): Promise<DocFileRow | null> {
  const result = await pool.query(
    `SELECT d.id AS doc_id, d.status, d.visibility, d.standard_id, d.created_by,
            f.id AS file_id, f.version, f.storage_path, f.original_filename,
            f.mime_type, f.file_size, f.checksum_sha256, f.page_count,
            f.preview_path, f.preview_pages, f.preview_status
     FROM documents d
     LEFT JOIN LATERAL (
       SELECT df.id, df.version, df.storage_path, df.original_filename, df.mime_type,
              df.file_size, df.checksum_sha256, df.page_count,
              df.preview_path, df.preview_pages, df.preview_status
       FROM document_files df
       WHERE df.document_id = d.id
       ORDER BY (df.id = d.current_file_id) DESC, df.version DESC, df.created_at DESC
       LIMIT 1
     ) f ON true
     WHERE d.id = $1`,
    [docId]
  );
  return (result.rows[0] as DocFileRow | undefined) ?? null;
}

/**
 * Route xem tài liệu online:
 * - GET /api/documents/:id/preview — bản xem trước giới hạn trang (file PDF
 *   đã cắt sẵn). Quyền = quyền thấy tài liệu theo ma trận hiện có.
 * - GET /api/documents/:id/view — bản gốc xem toàn bộ, CHỈ người tạo + admin.
 *
 * Với người chưa đăng nhập, mọi trường hợp "không tồn tại" và "không có
 * quyền" (members/internal/private/draft/hidden) đều trả 404 thống nhất
 * để không lộ sự tồn tại của tài liệu.
 * Endpoint preview TUYỆT ĐỐI không trả bytes file gốc: chỉ stream đúng
 * preview_path, thiếu preview thì trả lỗi chứ không fallback sang bản gốc.
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  storage: LocalDiskStorage,
  _cfg: AppConfig
): void {
  app.get(
    '/api/documents/:id/preview',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!z.string().uuid().safeParse(id).success) throw notFound();

      const row = await loadDocumentWithLatestFile(pool, id);
      if (!row || !row.file_id) throw notFound();

      const user = await getCurrentUser(pool, request.cookies);
      if (!canPreview(user, row)) {
        // Chưa đăng nhập: 404 thống nhất, không lộ tài liệu có tồn tại hay không.
        if (!user) throw notFound();
        throw forbidden('Bạn không có quyền xem tài liệu này');
      }

      if (row.mime_type !== PDF_MIME || row.preview_status === 'unsupported') {
        // Tài liệu PDF quá ngắn (preview sẽ bằng toàn bộ) là trường hợp riêng:
        // job đánh 'unsupported' kèm page_count — phân biệt bằng page_count.
        if (row.mime_type === PDF_MIME && row.page_count !== null && row.page_count <= 1) {
          throw new AppError(
            403,
            'PREVIEW_NOT_AVAILABLE',
            'Tài liệu này không có bản xem trước. Vui lòng liên hệ người tạo tài liệu để xem toàn bộ.'
          );
        }
        throw new AppError(
          415,
          'PREVIEW_UNSUPPORTED',
          'Định dạng tài liệu này chưa hỗ trợ xem trước trực tuyến.'
        );
      }

      if (
        row.page_count !== null &&
        row.preview_pages !== null &&
        row.preview_pages >= row.page_count
      ) {
        throw new AppError(
          403,
          'PREVIEW_NOT_AVAILABLE',
          'Tài liệu này không có bản xem trước. Vui lòng liên hệ người tạo tài liệu để xem toàn bộ.'
        );
      }

      if (row.preview_status !== 'ready' || !row.preview_path) {
        throw new AppError(
          404,
          'PREVIEW_NOT_READY',
          'Bản xem trước chưa sẵn sàng. Vui lòng thử lại sau ít phút.'
        );
      }

      const isPublic = row.status === 'published' && row.visibility === 'public';
      const etag = `"${row.checksum_sha256 ?? 'nohash'}-v${row.version ?? 1}-p${row.preview_pages ?? 0}"`;
      if (isPublic && request.headers['if-none-match'] === etag) {
        return reply
          .code(304)
          .header('ETag', etag)
          .header('Cache-Control', 'public, max-age=3600')
          .send();
      }

      // Chỉ mở đúng file xem trước — không bao giờ fallback sang file gốc.
      const stream = await storage.open(row.preview_path);
      request.log.info(
        {
          audit: 'document_preview',
          userId: user?.id ?? null,
          ip: request.ip,
          documentId: row.doc_id,
          fileId: row.file_id
        },
        'document preview viewed'
      );
      reply
        .header('Content-Type', PDF_MIME)
        .header('Content-Disposition', `inline; filename="preview-${row.doc_id}.pdf"`)
        .header('X-Content-Type-Options', 'nosniff');
      if (isPublic) {
        reply.header('Cache-Control', 'public, max-age=3600').header('ETag', etag);
      } else {
        reply.header('Cache-Control', 'private, no-store');
      }
      return reply.send(stream);
    }
  );

  app.get('/api/documents/:id/view', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound();

    const row = await loadDocumentWithLatestFile(pool, id);
    if (!row || !row.file_id || !row.storage_path) throw notFound();

    const user = await getCurrentUser(pool, request.cookies);
    if (!canViewFull(user, row)) {
      if (!user) throw notFound();
      throw forbidden('Chỉ người tạo tài liệu hoặc quản trị viên mới xem được toàn bộ tài liệu này');
    }

    const stream = await storage.open(row.storage_path);
    request.log.info(
      {
        audit: 'document_view_full',
        userId: user?.id ?? null,
        ip: request.ip,
        documentId: row.doc_id,
        fileId: row.file_id
      },
      'document viewed in full'
    );
    const encoded = encodeURIComponent(row.original_filename ?? 'document');
    reply
      .header('Content-Type', row.mime_type ?? 'application/octet-stream')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encoded}`)
      .header('Content-Length', String(row.file_size ?? ''))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(stream);
  });
}
