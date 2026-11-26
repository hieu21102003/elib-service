import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import {
  canDownloadOriginal,
  canUpload,
  canUploadStandardFile,
  type CurrentUser
} from '../auth/session.js';
import { findOrCreateStandardForUpload } from '../standards/repository.js';
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
  visibility: z.enum(['public', 'members', 'internal', 'private']).default('internal'),
  status: z.enum(['draft', 'published', 'hidden']).default('draft'),
  // File tiêu chuẩn: mã như trang chi tiết đang hiển thị (vd "TCVN 14552-1:2025").
  // Có standard_code -> gắn documents.standard_id, ép visibility 'internal',
  // price luôn NULL, chỉ nhận PDF, quyền tải lên = admin hoặc user_type=internal.
  standard_code: z.string().trim().max(200).optional().default(''),
  standard_title_vi: z.string().trim().max(1000).optional().default(''),
  standard_title_en: z.string().trim().max(1000).optional().default(''),
  standard_year: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return null;
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Number.isInteger(n) ? n : null;
    }),
  // Nhãn chữ của phiên bản (vd "Sửa đổi 1:2023"), tùy chọn.
  version_label: z.string().trim().max(100).optional().default(''),
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
  standard_id: string | null;
  current_file_id: string | null;
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
  version_label: string | null;
  uploaded_by: string | null;
  uploaded_at: Date | null;
  code_check_status: string | null;
  code_checked_at: Date | null;
  file_created_at: Date | null;
  toc_job_status?: string | null;
  toc_auto_status?: string | null;
  toc_manual_override?: boolean | null;
  toc_algorithm_version?: string | null;
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
    standard_id: row.standard_id,
    current_file_id: row.current_file_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Người dùng hiện tại có được xem TOÀN BỘ online không (chỉ người tạo + admin).
    can_view_full: canViewFull(user, row),
    // Người dùng hiện tại có được tải BẢN GỐC không (chỉ người tạo + admin;
    // chưa đăng nhập luôn false).
    can_download: canDownloadOriginal(user, row),
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
          version_label: row.version_label,
          uploaded_by: row.uploaded_by,
          uploaded_at: row.uploaded_at,
          code_check_status: row.code_check_status,
          code_checked_at: row.code_checked_at,
          created_at: row.file_created_at,
          toc_job_status: row.toc_job_status ?? null,
          toc_status:
            row.toc_manual_override === true ? 'ok' : (row.toc_auto_status ?? null),
          toc_has_manual: row.toc_manual_override === true,
          toc_algorithm_version: row.toc_algorithm_version ?? null
        }
      : null,
    tags: row.tag_names ?? [],
    category: row.category_ref_id ? { id: row.category_ref_id, name: row.category_name } : null
  };
}

const patchVisibilitySchema = z.object({
  visibility: z.enum(['public', 'members', 'internal', 'private'])
});

const patchCurrentVersionSchema = z.object({
  file_id: z.string().uuid()
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
    // Cổng thô: phải có ít nhất một trong hai quyền tải lên (tài liệu thường
    // hoặc file tiêu chuẩn). Quyền chính xác kiểm tra lại sau khi đọc
    // standard_code từ multipart.
    if (!canUpload(user) && !canUploadStandardFile(user)) {
      throw forbidden('Bạn không có quyền upload tài liệu. Chỉ admin hoặc editor mới được upload.');
    }

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
        standard_code: fields.standard_code ?? '',
        standard_title_vi: fields.standard_title_vi ?? '',
        standard_title_en: fields.standard_title_en ?? '',
        standard_year: fields.standard_year,
        version_label: fields.version_label ?? '',
        force: fields.force
      });
      if (!metaParsed.success) {
        throw badRequest('INVALID_METADATA', 'Thông tin tài liệu không hợp lệ. Vui lòng kiểm tra lại các trường bắt buộc.');
      }
      const meta = metaParsed.data;
      const isStandardUpload = meta.standard_code.length > 0;
      if (isStandardUpload) {
        if (!canUploadStandardFile(user)) {
          throw forbidden(
            'Chỉ quản trị viên hoặc người trong tổ chức mới tải được file tiêu chuẩn.'
          );
        }
      } else if (!canUpload(user)) {
        throw forbidden('Bạn không có quyền upload tài liệu. Chỉ admin hoặc editor mới được upload.');
      }

      const { displayName, extension: declaredExt } = sanitizeFilename(originalFilename);
      assertSizeWithinLimit(fileSize, cfg.maxUploadBytes);
      const detected = await detectFileTypeFromPath(tempPath, declaredExt);
      if (isStandardUpload && detected.kind !== 'pdf') {
        throw badRequest(
          'STANDARD_FILE_MUST_BE_PDF',
          'File tiêu chuẩn chỉ chấp nhận định dạng PDF.'
        );
      }

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

      // File tiêu chuẩn: tra/tạo bản ghi standards theo mã đã chuẩn hóa nhẹ
      // (khớp normalized_code + code_key_raw), rồi tìm document đã gắn với
      // tiêu chuẩn đó — một tiêu chuẩn = một document, upload lại là version mới.
      let standardId: string | null = null;
      let standardInfo: { id: string; normalized_code: string; code_display: string } | null = null;
      let existingStandardDocId: string | null = null;
      if (isStandardUpload) {
        const resolved = await findOrCreateStandardForUpload(pool, meta.standard_code, {
          titleVi: meta.standard_title_vi || null,
          titleEn: meta.standard_title_en || null,
          year: meta.standard_year
        });
        if (!resolved) {
          throw badRequest(
            'INVALID_STANDARD_CODE',
            'Mã tiêu chuẩn không hợp lệ. Vui lòng kiểm tra lại số hiệu tiêu chuẩn.'
          );
        }
        standardId = resolved.standard.id;
        standardInfo = {
          id: resolved.standard.id,
          normalized_code: resolved.standard.normalized_code,
          code_display: resolved.standard.code_display
        };
        const existingDoc = await pool.query(
          'SELECT id FROM documents WHERE standard_id = $1 ORDER BY created_at ASC LIMIT 1',
          [standardId]
        );
        existingStandardDocId = (existingDoc.rows[0] as { id: string } | undefined)?.id ?? null;
      }

      const docId = existingStandardDocId ?? randomUUID();
      const fileId = randomUUID();
      let version = 1;
      if (existingStandardDocId) {
        const next = await pool.query(
          'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM document_files WHERE document_id = $1',
          [docId]
        );
        version = Number((next.rows[0] as { next_version: number }).next_version);
      }
      finalRelativePath = storage.buildOriginalPath(docId, version, fileId, detected.extension);

      // Chuyển file tạm vào chỗ chính thức TRƯỚC khi ghi DB.
      await storage.commitTemp(tempPath, finalRelativePath);
      tempPath = null; // đã chuyển, không còn file tạm

      const tagNames = parseTags(meta.tags ?? '');
      let createdDoc: Record<string, unknown>;
      let createdFile: Record<string, unknown>;
      try {
        const result = await withTransaction(pool, async (client) => {
          const insertFile = async () => {
            const fileRes = await client.query(
              `INSERT INTO document_files
                 (id, document_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, page_count, preview_status, version_label, uploaded_by, code_check_status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12)
               RETURNING id, document_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, page_count, preview_status, version_label, uploaded_by, uploaded_at, code_check_status, created_at`,
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
                detected.kind === 'pdf' ? 'pending' : 'unsupported',
                meta.version_label ? meta.version_label : null,
                user.id,
                // Chỉ file tiêu chuẩn mới vào hàng đợi kiểm tra mã.
                isStandardUpload ? 'pending' : null
              ]
            );
            // Chỉ xếp hàng mục lục cho PDF thuộc phạm vi cấu hình (mặc định: file tiêu chuẩn).
            if (detected.kind === 'pdf' && (isStandardUpload || !cfg.tocStandardsOnly)) {
              await client.query(
                `INSERT INTO document_file_tocs (file_id, job_status)
                 VALUES ($1, 'pending')
                 ON CONFLICT (file_id) DO NOTHING`,
                [fileId]
              );
            }
            return fileRes;
          };

          if (existingStandardDocId) {
            // Phiên bản sửa đổi của tiêu chuẩn đã có document: thêm file mới,
            // con trỏ hiện hành chuyển sang bản mới (admin đặt lại được).
            const fileRes = await insertFile();
            const docRes = await client.query(
              `UPDATE documents SET current_file_id = $1, updated_at = now() WHERE id = $2
               RETURNING id, title, slug, description, category_id, doc_type, language, visibility, status, price, standard_id, current_file_id, created_by, created_at, updated_at`,
              [fileId, docId]
            );
            return { doc: docRes.rows[0], file: fileRes.rows[0] };
          }

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
               (id, title, slug, description, category_id, doc_type, language, visibility, status, price, standard_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11)
             RETURNING id, title, slug, description, category_id, doc_type, language, visibility, status, price, standard_id, current_file_id, created_by, created_at, updated_at`,
            [
              docId,
              meta.title,
              slug,
              meta.description ? meta.description : null,
              meta.category_id ?? null,
              meta.doc_type ? meta.doc_type : null,
              meta.language ? meta.language : null,
              // File tiêu chuẩn đã mua: ÉP visibility 'internal' (bỏ qua giá trị
              // client gửi) — chỉ người trong tổ chức mới thấy được.
              isStandardUpload ? 'internal' : meta.visibility,
              meta.status,
              standardId,
              user.id
            ]
          );
          const fileRes = await insertFile();
          await client.query('UPDATE documents SET current_file_id = $1 WHERE id = $2', [
            fileId,
            docId
          ]);
          (docRes.rows[0] as Record<string, unknown>).current_file_id = fileId;
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
          version_label: createdFile.version_label,
          uploaded_by: createdFile.uploaded_by,
          uploaded_at: createdFile.uploaded_at,
          code_check_status: createdFile.code_check_status,
          created_at: createdFile.created_at
          // storage_path tương đối chỉ trả khi cần debug nội bộ? Không trả đường dẫn tuyệt đối.
        },
        standard: standardInfo,
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
           d.visibility, d.status, d.price, d.standard_id, d.current_file_id,
           d.created_by, d.created_at, d.updated_at,
           f.id AS file_id, f.document_id AS file_document_id, f.version AS file_version,
           f.original_filename, f.mime_type, f.file_size, f.page_count,
           f.preview_pages, f.preview_status, f.version_label, f.uploaded_by,
           f.uploaded_at, f.code_check_status, f.code_checked_at,
           f.created_at AS file_created_at,
           toc.job_status AS toc_job_status, toc.auto_status AS toc_auto_status,
           toc.manual_override AS toc_manual_override, toc.algorithm_version AS toc_algorithm_version,
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
                  df.preview_status, df.version_label, df.uploaded_by,
                  df.uploaded_at, df.code_check_status, df.code_checked_at,
                  df.created_at
           FROM document_files df
           WHERE df.document_id = d.id
           ORDER BY (df.id = d.current_file_id) DESC, df.version DESC, df.created_at DESC
           LIMIT 1
         ) f ON true
         LEFT JOIN document_file_tocs toc ON toc.file_id = f.id
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
  // (visibleDocumentsWhere, canDownloadOriginal, canPreview) không đổi.
  app.patch('/api/documents/:id', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();

    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound();

    const parsed = patchVisibilitySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'INVALID_VISIBILITY',
        'Mức hiển thị không hợp lệ. Chỉ chấp nhận: public, members, internal, private.'
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

  // Đặt lại phiên bản hiện hành về một file cũ — CHỈ admin. Con trỏ
  // documents.current_file_id quyết định file nào được phục vụ ở danh sách,
  // /preview và /view; các phiên bản khác vẫn giữ nguyên trên đĩa + DB.
  app.patch('/api/documents/:id/current-version', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();
    if (user.role !== 'admin') {
      throw forbidden('Chỉ quản trị viên mới đặt lại được phiên bản hiện hành');
    }

    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound();

    const parsed = patchCurrentVersionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_FILE_ID', 'Thiếu hoặc sai định dạng file_id của phiên bản cần đặt.');
    }
    const fileId = parsed.data.file_id;

    const docRes = await pool.query(
      'SELECT id, current_file_id FROM documents WHERE id = $1',
      [id]
    );
    const doc = docRes.rows[0] as { id: string; current_file_id: string | null } | undefined;
    if (!doc) throw notFound();

    const fileRes = await pool.query(
      'SELECT id, version FROM document_files WHERE id = $1 AND document_id = $2',
      [fileId, id]
    );
    const file = fileRes.rows[0] as { id: string; version: number } | undefined;
    if (!file) throw notFound();

    const updated = await pool.query(
      `UPDATE documents SET current_file_id = $1, updated_at = now() WHERE id = $2
       RETURNING id, current_file_id, updated_at`,
      [fileId, id]
    );
    const row = updated.rows[0] as { id: string; current_file_id: string; updated_at: Date };

    request.log.info(
      {
        audit: 'document_current_version_changed',
        userId: user.id,
        documentId: row.id,
        oldFileId: doc.current_file_id,
        newFileId: row.current_file_id,
        newVersion: file.version
      },
      'document current version changed'
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
    // Tải bản gốc: CHỈ người tạo tài liệu hoặc admin (canDownloadOriginal).
    // Chưa đăng nhập giữ quy ước cũ của route này (401); đã đăng nhập mà
    // không có quyền -> 403 DOWNLOAD_FORBIDDEN. Tài liệu/file không tồn tại
    // vẫn 404 như trước (kiểm tra ở trên, không lộ thêm thông tin).
    if (!canDownloadOriginal(user, row)) {
      if (!user) throw unauthorized('Bạn cần đăng nhập để tải tài liệu này');
      throw new AppError(
        403,
        'DOWNLOAD_FORBIDDEN',
        'Chỉ người tạo tài liệu hoặc quản trị viên mới tải được bản gốc của tài liệu này'
      );
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
