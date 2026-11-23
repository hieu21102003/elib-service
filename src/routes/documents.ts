import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { canDownload, canUpload, type CurrentUser } from '../auth/session.js';
import { canViewFull } from '../previews/permissions.js';
import { parseDocumentListQuery } from '../documents/list-query.js';
import { searchPredicate } from '../documents/search.js';
import { visibleDocumentsWhere } from '../documents/visibility.js';
import { getCurrentUser } from './auth.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { HashAndCountTransform } from '../files/checksum.js';
import { sanitizeFilename } from '../files/filename.js';
import { assertSizeWithinLimit, detectFileTypeFromPath } from '../files/validation.js';
import { slugify } from '../slug.js';

const metadataSchema = z.object({
  title: z.string().trim().min(1, 'Thiếu tiêu đề tài liệu').max(300),
  description: z.string().trim().max(5000).optional().default(''),
  category_id: z.string().uuid().optional().nullable(),
  tags: z.string().optional().default(''),
  doc_type: z.string().trim().max(100).optional().default(''),
  language: z.string().trim().max(50).optional().default(''),
  visibility: z.enum(['public', 'internal', 'private']).default('internal'),
  status: z.enum(['draft', 'published', 'hidden']).default('draft'),
  force: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1')
});

/** Một dòng kết quả của truy vấn danh sách tài liệu (đã JOIN file mới nhất + danh mục + thẻ). */
interface DocumentListRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  doc_type: string | null;
  language: string | null;
  visibility: string;
  status: string;
  price: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  file_id: string | null;
  file_document_id: string | null;
  file_version: number | null;
  original_filename: string | null;
  mime_type: string | null;
  file_size: string | null;
  page_count: number | null;
  preview_pages: number | null;
  preview_status: string | null;
  file_created_at: Date | null;
  category_ref_id: string | null;
  category_name: string | null;
  tag_names: string[] | null;
}

function mapDocumentListRow(row: DocumentListRow, user: CurrentUser | null) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    category_id: row.category_id,
    doc_type: row.doc_type,
    language: row.language,
    visibility: row.visibility,
    status: row.status,
    // price: NULL ở Giai đoạn 1; khi có giá, pg trả numeric dạng chuỗi — giữ nguyên.
    price: row.price,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Người dùng hiện tại có được xem TOÀN BỘ online không (chỉ người tạo + admin).
    can_view_full: canViewFull(user, row),
    // File phiên bản mới nhất của tài liệu; KHÔNG bao giờ trả storage_path/preview_path.
    file: row.file_id
      ? {
          id: row.file_id,
          document_id: row.file_document_id,
          version: row.file_version,
          original_filename: row.original_filename,
          mime_type: row.mime_type,
          file_size: row.file_size === null ? null : Number(row.file_size),
          page_count: row.page_count,
          preview_pages: row.preview_pages,
          preview_status: row.preview_status,
          created_at: row.file_created_at
        }
      : null,
    tags: row.tag_names ?? [],
    category: row.category_ref_id ? { id: row.category_ref_id, name: row.category_name } : null
  };
}

const patchVisibilitySchema = z.object({
  visibility: z.enum(['public', 'internal', 'private'])
});

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, 30);
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig
): void {
  app.post('/api/documents', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();
    if (!canUpload(user)) throw forbidden('Bạn không có quyền upload tài liệu. Chỉ admin hoặc editor mới được upload.');

    let tempPath: string | null = null;
    let finalRelativePath: string | null = null;
    try {
      const fields: Record<string, string> = {};
      let originalFilename: string | null = null;
      let checksum = '';
      let fileSize = 0;
      let sawFile = false;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          if (sawFile) {
            // Giai đoạn 1 chỉ 1 file: xả bỏ file thừa để tránh treo request.
            part.file.resume();
            throw badRequest('TOO_MANY_FILES', 'Giai đoạn 1 chỉ upload một file mỗi lần.');
          }
          sawFile = true;
          originalFilename = part.filename;
          tempPath = await storage.createTempPath();
          const counter = new HashAndCountTransform(cfg.maxUploadBytes);
          try {
            await pipeline(part.file, counter, createWriteStream(tempPath, { flags: 'wx' }));
          } catch (err) {
            if (counter.exceeded || (err as Error).message === 'FILE_TOO_LARGE' || part.file.truncated) {
              throw badRequest('FILE_TOO_LARGE', `File vượt quá dung lượng tối đa ${cfg.maxUploadMb} MB.`);
            }
            throw err;
          }
          if (part.file.truncated || counter.exceeded) {
            throw badRequest('FILE_TOO_LARGE', `File vượt quá dung lượng tối đa ${cfg.maxUploadMb} MB.`);
          }
          checksum = counter.digestHex();
          fileSize = counter.size;
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }

      if (!sawFile || !tempPath || !originalFilename) {
        throw badRequest('MISSING_FILE', 'Chưa chọn file để upload.');
      }

      const metaParsed = metadataSchema.safeParse({
        title: fields.title,
        description: fields.description ?? '',
        category_id: fields.category_id ? fields.category_id : undefined,
        tags: fields.tags ?? '',
        doc_type: fields.doc_type ?? '',
        language: fields.language ?? '',
        visibility: fields.visibility || 'internal',
        status: fields.status || 'draft',
        force: fields.force
      });
      if (!metaParsed.success) {
        throw badRequest('INVALID_METADATA', 'Thông tin tài liệu không hợp lệ. Vui lòng kiểm tra lại các trường bắt buộc.');
      }
      const meta = metaParsed.data;

      const { displayName, extension: declaredExt } = sanitizeFilename(originalFilename);
      assertSizeWithinLimit(fileSize, cfg.maxUploadBytes);
      const detected = await detectFileTypeFromPath(tempPath, declaredExt);

      if (meta.category_id) {
        const cat = await pool.query('SELECT id FROM categories WHERE id = $1', [meta.category_id]);
        if (cat.rows.length === 0) {
          throw badRequest('INVALID_CATEGORY', 'Danh mục đã chọn không tồn tại.');
        }
      }

      // Kiểm tra trùng checksum.
      const dup = await pool.query(
        `SELECT d.id AS document_id, d.title, f.id AS file_id
         FROM document_files f JOIN documents d ON d.id = f.document_id
         WHERE f.checksum_sha256 = $1 LIMIT 1`,
        [checksum]
      );
      if (dup.rows.length > 0 && !meta.force) {
        const existing = dup.rows[0] as { document_id: string; title: string; file_id: string };
        throw conflict(
          'DUPLICATE_FILE',
          `File này đã tồn tại trong thư viện (tài liệu "${existing.title}"). Bạn có thể bỏ qua hoặc vẫn tạo mới.`,
          {
            existingDocumentId: existing.document_id,
            existingTitle: existing.title,
            existingFileId: existing.file_id,
            checksumSha256: checksum
          }
        );
      }

      const docId = randomUUID();
      const fileId = randomUUID();
      const version = 1; // Giai đoạn 1 luôn là phiên bản 1
      finalRelativePath = storage.buildOriginalPath(docId, version, fileId, detected.extension);

      // Chuyển file tạm vào chỗ chính thức TRƯỚC khi ghi DB.
      await storage.commitTemp(tempPath, finalRelativePath);
      tempPath = null; // đã chuyển, không còn file tạm

      const tagNames = parseTags(meta.tags ?? '');
      let createdDoc: Record<string, unknown>;
      let createdFile: Record<string, unknown>;
      try {
        const result = await withTransaction(pool, async (client) => {
          // Slug duy nhất: thử slug gốc, rồi -2, -3, ...
          const baseSlug = slugify(meta.title);
          let slug = baseSlug;
          for (let i = 2; ; i++) {
            const existing = await client.query('SELECT id FROM documents WHERE slug = $1', [slug]);
            if (existing.rows.length === 0) break;
            slug = `${baseSlug}-${i}`;
          }
          const docRes = await client.query(
            `INSERT INTO documents
               (id, title, slug, description, category_id, doc_type, language, visibility, status, price, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10)
             RETURNING id, title, slug, description, category_id, doc_type, language, visibility, status, price, created_by, created_at, updated_at`,
            [
              docId,
              meta.title,
              slug,
              meta.description ? meta.description : null,
              meta.category_id ?? null,
              meta.doc_type ? meta.doc_type : null,
              meta.language ? meta.language : null,
              meta.visibility,
              meta.status,
              user.id
            ]
          );
          const fileRes = await client.query(
            `INSERT INTO document_files
               (id, document_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, page_count, preview_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)
             RETURNING id, document_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, page_count, preview_status, created_at`,
            [
              fileId,
              docId,
              version,
              finalRelativePath,
              displayName,
              detected.mimeType,
              fileSize,
              checksum,
              // PDF -> job nền sẽ tạo bản xem trước; định dạng khác chưa hỗ trợ.
              detected.kind === 'pdf' ? 'pending' : 'unsupported'
            ]
          );
          for (const tagName of tagNames) {
            const normalized = tagName.toLowerCase();
            const tagRes = await client.query(
              `INSERT INTO tags (name, normalized_name) VALUES ($1,$2)
               ON CONFLICT (normalized_name) DO UPDATE SET name = tags.name
               RETURNING id`,
              [tagName, normalized]
            );
            await client.query(
              'INSERT INTO document_tags (document_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
              [docId, tagRes.rows[0].id]
            );
          }
          return { doc: docRes.rows[0], file: fileRes.rows[0] };
        });
        createdDoc = result.doc as Record<string, unknown>;
        createdFile = result.file as Record<string, unknown>;
      } catch (dbErr) {
        // Ghi DB thất bại -> xóa file vừa chuyển, không để file mồ côi.
        if (finalRelativePath) await storage.delete(finalRelativePath).catch(() => undefined);
        finalRelativePath = null;
        throw dbErr;
      }

      return reply.code(201).send({
        document: createdDoc,
        file: {
          id: createdFile.id,
          document_id: createdFile.document_id,
          version: createdFile.version,
          original_filename: createdFile.original_filename,
          mime_type: createdFile.mime_type,
          file_size: Number(createdFile.file_size),
          checksum_sha256: createdFile.checksum_sha256,
          page_count: createdFile.page_count,
          preview_status: createdFile.preview_status,
          created_at: createdFile.created_at
          // storage_path tương đối chỉ trả khi cần debug nội bộ? Không trả đường dẫn tuyệt đối.
        },
        tags: tagNames
      });
    } catch (err) {
      // Dọn file tạm trong mọi trường hợp lỗi.
      if (tempPath) await storage.discardTemp(tempPath);
      throw err;
    }
  });

  app.get(
    '/api/documents',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = parseDocumentListQuery(request.query);
      const user = await getCurrentUser(pool, request.cookies);

      const params: unknown[] = [];
      const where: string[] = [];

      // Lọc quyền NGAY TRONG SQL — áp dụng cho cả danh sách lẫn total,
      // tài liệu không có quyền xem không lộ qua kết quả hay số lượng.
      const vis = visibleDocumentsWhere(user, params.length + 1);
      where.push(vis.sql);
      params.push(...vis.params);

      const search = searchPredicate(query.q, params.length + 1);
      if (search) {
        where.push(search.sql);
        params.push(...search.params);
      }

      if (query.categoryId) {
        params.push(query.categoryId);
        where.push(`d.category_id = $${params.length}`);
      }

      const whereSql = where.join(' AND ');

      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM documents d WHERE ${whereSql}`,
        params
      );
      const total = (countRes.rows[0] as { total: number }).total;

      const listParams = [...params, query.limit, query.offset];
      const listRes = await pool.query(
        `SELECT
           d.id, d.title, d.slug, d.description, d.category_id, d.doc_type, d.language,
           d.visibility, d.status, d.price, d.created_by, d.created_at, d.updated_at,
           f.id AS file_id, f.document_id AS file_document_id, f.version AS file_version,
           f.original_filename, f.mime_type, f.file_size, f.page_count,
           f.preview_pages, f.preview_status, f.created_at AS file_created_at,
           c.id AS category_ref_id, c.name AS category_name,
           COALESCE((
             SELECT array_agg(t.name ORDER BY t.name)
             FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
             WHERE dt.document_id = d.id
           ), ARRAY[]::text[]) AS tag_names
         FROM documents d
         LEFT JOIN LATERAL (
           SELECT df.id, df.document_id, df.version, df.original_filename,
                  df.mime_type, df.file_size, df.page_count, df.preview_pages,
                  df.preview_status, df.created_at
           FROM document_files df
           WHERE df.document_id = d.id
           ORDER BY df.version DESC, df.created_at DESC
           LIMIT 1
         ) f ON true
         LEFT JOIN categories c ON c.id = d.category_id
         WHERE ${whereSql}
         ORDER BY d.created_at DESC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      );

      const data = (listRes.rows as DocumentListRow[]).map((row) => mapDocumentListRow(row, user));
      return reply.send({ data, total, limit: query.limit, offset: query.offset });
    }
  );

  // Đổi mức hiển thị (visibility) của tài liệu — CHỈ admin hoặc người tạo.
  // Chỉ ghi cột visibility (+ updated_at); ma trận quyền đọc/tải/preview
  // (visibleDocumentsWhere, canDownload, canPreview) không đổi.
  app.patch('/api/documents/:id', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();

    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound();

    const parsed = patchVisibilitySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'INVALID_VISIBILITY',
        'Mức hiển thị không hợp lệ. Chỉ chấp nhận: public, internal, private.'
      );
    }
    const newVisibility = parsed.data.visibility;

    const found = await pool.query(
      'SELECT id, title, visibility, status, created_by FROM documents WHERE id = $1',
      [id]
    );
    const doc = found.rows[0] as
      | { id: string; title: string; visibility: string; status: string; created_by: string | null }
      | undefined;
    if (!doc) throw notFound();

    if (user.role !== 'admin' && user.id !== doc.created_by) {
      throw forbidden('Chỉ quản trị viên hoặc người tạo tài liệu mới đổi được mức hiển thị');
    }

    const updated = await pool.query(
      `UPDATE documents SET visibility = $1, updated_at = now() WHERE id = $2
       RETURNING id, title, visibility, status, updated_at`,
      [newVisibility, id]
    );
    const row = updated.rows[0] as {
      id: string;
      title: string;
      visibility: string;
      status: string;
      updated_at: Date;
    };

    request.log.info(
      {
        audit: 'document_visibility_changed',
        userId: user.id,
        documentId: row.id,
        oldVisibility: doc.visibility,
        newVisibility: row.visibility
      },
      'document visibility changed'
    );

    return reply.send({ document: row });
  });

  app.get('/api/documents/:id/files/:fileId/download', async (request, reply) => {
    const { id, fileId } = request.params as { id: string; fileId: string };
    const idOk = z.string().uuid().safeParse(id).success;
    const fileOk = z.string().uuid().safeParse(fileId).success;
    if (!idOk || !fileOk) throw notFound();

    const result = await pool.query(
      `SELECT d.id AS doc_id, d.status, d.visibility, d.created_by,
              f.id AS file_id, f.storage_path, f.original_filename, f.mime_type, f.file_size
       FROM documents d JOIN document_files f ON f.document_id = d.id
       WHERE d.id = $1 AND f.id = $2`,
      [id, fileId]
    );
    const row = result.rows[0] as
      | {
          doc_id: string;
          status: string;
          visibility: string;
          created_by: string | null;
          file_id: string;
          storage_path: string;
          original_filename: string;
          mime_type: string;
          file_size: string;
        }
      | undefined;
    if (!row) throw notFound();

    const user = await getCurrentUser(pool, request.cookies);
    if (!canDownload(user, row)) {
      if (!user) throw unauthorized('Bạn cần đăng nhập để tải tài liệu này');
      throw forbidden('Bạn không có quyền tải tài liệu này');
    }

    const stream = await storage.open(row.storage_path);
    const encoded = encodeURIComponent(row.original_filename);
    reply
      .header('Content-Type', row.mime_type)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`)
      .header('Content-Length', String(row.file_size))
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(stream);
  });
}
