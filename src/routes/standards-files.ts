import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { notFound } from '../errors.js';
import { canDownloadOriginal, type CurrentUser } from '../auth/session.js';
import { visibleInList } from '../documents/visibility.js';
import { canViewFull } from '../previews/permissions.js';
import { findStandardByCode } from '../standards/repository.js';
import { getCurrentUser } from './auth.js';

/**
 * GET /api/standards/:code/files — file PDF đã gắn cho một tiêu chuẩn.
 *
 * Trả metadata tiêu chuẩn (luôn công khai trong nội bộ hệ thống) + document
 * gắn kèm + file hiện hành + toàn bộ lịch sử phiên bản. Quyền thấy document
 * áp ĐÚNG ma trận danh sách (visibleInList): người không có quyền (chưa
 * đăng nhập, external với tài liệu internal...) nhận document: null và
 * danh sách phiên bản rỗng — không lộ sự tồn tại của file đã mua.
 * Không bao giờ trả storage_path/preview_path.
 */

interface StandardDocRow {
  id: string;
  title: string;
  visibility: string;
  status: string;
  price: string | null;
  standard_id: string | null;
  current_file_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StandardFileRow {
  id: string;
  document_id: string;
  version: number;
  version_label: string | null;
  uploaded_by: string | null;
  uploaded_at: Date | null;
  original_filename: string;
  mime_type: string;
  file_size: string;
  page_count: number | null;
  preview_pages: number | null;
  preview_status: string | null;
  code_check_status: string | null;
  code_checked_at: Date | null;
  created_at: Date;
}

function mapFile(row: StandardFileRow) {
  return {
    id: row.id,
    document_id: row.document_id,
    version: row.version,
    version_label: row.version_label,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    file_size: Number(row.file_size),
    page_count: row.page_count,
    preview_pages: row.preview_pages,
    preview_status: row.preview_status,
    code_check_status: row.code_check_status,
    code_checked_at: row.code_checked_at,
    created_at: row.created_at
  };
}

export function registerStandardFileRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get(
    '/api/standards/:code/files',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const standard = await findStandardByCode(pool, code);
      if (!standard) throw notFound('Không tìm thấy tiêu chuẩn');

      const user: CurrentUser | null = await getCurrentUser(pool, request.cookies);

      const docRes = await pool.query(
        `SELECT id, title, visibility, status, price, standard_id, current_file_id,
                created_by, created_at, updated_at
         FROM documents WHERE standard_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [standard.id]
      );
      const doc = docRes.rows[0] as StandardDocRow | undefined;

      const standardPayload = {
        id: standard.id,
        normalized_code: standard.normalized_code,
        base_key: standard.base_key,
        code_key_raw: standard.code_key_raw,
        code_display: standard.code_display,
        title_vi: standard.title_vi,
        title_en: standard.title_en,
        year: standard.year,
        status: standard.status,
        detail_level: standard.detail_level,
        is_amendment: standard.is_amendment,
        is_draft: standard.is_draft,
        needs_review: standard.needs_review
      };

      if (!doc || !visibleInList(user, doc)) {
        return reply.send({
          standard: standardPayload,
          document: null,
          current_file: null,
          versions: []
        });
      }

      const filesRes = await pool.query(
        `SELECT id, document_id, version, version_label, uploaded_by, uploaded_at,
                original_filename, mime_type, file_size, page_count, preview_pages,
                preview_status, code_check_status, code_checked_at, created_at
         FROM document_files WHERE document_id = $1
         ORDER BY version DESC, created_at DESC`,
        [doc.id]
      );
      const files = filesRes.rows as StandardFileRow[];
      const current =
        files.find((f) => f.id === doc.current_file_id) ?? files[0] ?? null;

      return reply.send({
        standard: standardPayload,
        document: {
          id: doc.id,
          title: doc.title,
          visibility: doc.visibility,
          status: doc.status,
          price: doc.price,
          standard_id: doc.standard_id,
          current_file_id: doc.current_file_id,
          created_by: doc.created_by,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
          can_view_full: canViewFull(user, doc),
          can_download: canDownloadOriginal(user, doc)
        },
        current_file: current ? mapFile(current) : null,
        versions: files.map(mapFile)
      });
    }
  );
}
