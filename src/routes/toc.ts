import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isActiveUser, type CurrentUser } from '../auth/session.js';
import type { AppConfig } from '../config.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { canPreview, canViewFull } from '../previews/permissions.js';
import { normalizeUnicode } from '../toc/normalize.js';
import { canManageToc } from '../toc/permissions.js';
import {
  DEFAULT_TOC_LIMITS,
  type OffsetInfo,
  type StoredTocNode,
  type TocAutoPayload,
  type TocJobStatus,
  type TocManualPayload,
  type TocStatus,
} from '../toc/types.js';
import { TOC_ALGORITHM_VERSION, TOC_SCHEMA_VERSION } from '../toc/version.js';
import { getCurrentUser } from './auth.js';

const PDF_MIME = 'application/pdf';

interface DocFileTocRow {
  doc_id: string;
  status: string;
  visibility: string;
  standard_id: string | null;
  current_file_id: string | null;
  created_by: string | null;
  file_id: string | null;
  version: number | null;
  version_label: string | null;
  uploaded_by: string | null;
  uploaded_at: Date | string | null;
  mime_type: string | null;
  page_count: number | null;
  preview_pages: number | null;
  toc_file_id: string | null;
  job_status: TocJobStatus | null;
  auto_status: TocStatus | null;
  auto_strategy: string | null;
  auto_flags: string[] | null;
  auto_payload: TocAutoPayload | null;
  algorithm_version: string | null;
  manual_override: boolean | null;
  manual_payload: TocManualPayload | null;
}

interface AdminFileTocRow {
  file_id: string;
  document_id: string;
  standard_id: string | null;
  current_file_id: string | null;
  document_title: string;
  standard_code_display: string | null;
  version: number;
  version_label: string | null;
  uploaded_by: string | null;
  uploaded_at: Date | string | null;
  original_filename: string;
  mime_type: string;
  page_count: number | null;
  toc_file_id: string | null;
  job_status: TocJobStatus | null;
  attempts: number | null;
  locked_at: Date | string | null;
  last_error: string | null;
  auto_status: TocStatus | null;
  auto_strategy: string | null;
  auto_flags: string[] | null;
  auto_payload: TocAutoPayload | null;
  algorithm_version: string | null;
  extracted_at: Date | string | null;
  manual_override: boolean | null;
  manual_payload: TocManualPayload | null;
  manual_updated_by: string | null;
  manual_updated_at: Date | string | null;
}

const optionalBoolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const adminListQuerySchema = z.object({
  auto_status: z.enum(['ok', 'partial', 'needs_ocr', 'failed', 'unsupported']).optional(),
  flag: z.string().trim().min(1).max(100).optional(),
  job_status: z.enum(['pending', 'processing', 'done', 'failed', 'unsupported']).optional(),
  manual_override: optionalBoolQuery,
  standards_only: optionalBoolQuery,
  outdated_algorithm: optionalBoolQuery,
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const putManualSchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
  nodes: z
    .array(
      z.object({
        title: z.string(),
        level: z.number().int().min(1).max(6),
        page_pdf: z.number().int().min(1),
      })
    )
    .max(DEFAULT_TOC_LIMITS.maxNodes),
});

const promoteAutoSchema = z.object({
  activate: z.boolean().optional().default(true),
  note: z.string().trim().max(500).nullable().optional(),
});

function isValidUuid(id: string): boolean {
  return z.string().uuid().safeParse(id).success;
}

async function loadCurrentDocFileToc(pool: pg.Pool, docId: string): Promise<DocFileTocRow | null> {
  const res = await pool.query(
    `SELECT d.id AS doc_id, d.status, d.visibility, d.standard_id, d.current_file_id, d.created_by,
            f.id AS file_id, f.version, f.version_label, f.uploaded_by, f.uploaded_at,
            f.mime_type, f.page_count, f.preview_pages,
            t.file_id AS toc_file_id, t.job_status, t.auto_status, t.auto_strategy,
            t.auto_flags, t.auto_payload, t.algorithm_version,
            t.manual_override, t.manual_payload
     FROM documents d
     LEFT JOIN LATERAL (
       SELECT df.id, df.version, df.version_label, df.uploaded_by, df.uploaded_at,
              df.mime_type, df.page_count, df.preview_pages
       FROM document_files df
       WHERE df.document_id = d.id
       ORDER BY (df.id = d.current_file_id) DESC, df.version DESC, df.created_at DESC
       LIMIT 1
     ) f ON true
     LEFT JOIN document_file_tocs t ON t.file_id = f.id
     WHERE d.id = $1`,
    [docId]
  );
  return (res.rows[0] as DocFileTocRow | undefined) ?? null;
}

async function loadSpecificDocFileToc(
  pool: pg.Pool,
  docId: string,
  fileId: string
): Promise<DocFileTocRow | null> {
  const res = await pool.query(
    `SELECT d.id AS doc_id, d.status, d.visibility, d.standard_id, d.current_file_id, d.created_by,
            df.id AS file_id, df.version, df.version_label, df.uploaded_by, df.uploaded_at,
            df.mime_type, df.page_count, df.preview_pages,
            t.file_id AS toc_file_id, t.job_status, t.auto_status, t.auto_strategy,
            t.auto_flags, t.auto_payload, t.algorithm_version,
            t.manual_override, t.manual_payload
     FROM documents d
     JOIN document_files df ON df.document_id = d.id AND df.id = $2
     LEFT JOIN document_file_tocs t ON t.file_id = df.id
     WHERE d.id = $1`,
    [docId, fileId]
  );
  return (res.rows[0] as DocFileTocRow | undefined) ?? null;
}

async function loadAdminFileToc(pool: pg.Pool, fileId: string): Promise<AdminFileTocRow | null> {
  const res = await pool.query(
    `SELECT df.id AS file_id, df.document_id, d.standard_id, d.current_file_id,
            d.title AS document_title, s.code_display AS standard_code_display,
            df.version, df.version_label, df.uploaded_by, df.uploaded_at,
            df.original_filename, df.mime_type, df.page_count,
            t.file_id AS toc_file_id, t.job_status, t.attempts, t.locked_at, t.last_error,
            t.auto_status, t.auto_strategy, t.auto_flags, t.auto_payload,
            t.algorithm_version, t.extracted_at,
            t.manual_override, t.manual_payload, t.manual_updated_by, t.manual_updated_at
     FROM document_files df
     JOIN documents d ON d.id = df.document_id
     LEFT JOIN standards s ON s.id = d.standard_id
     LEFT JOIN document_file_tocs t ON t.file_id = df.id
     WHERE df.id = $1`,
    [fileId]
  );
  return (res.rows[0] as AdminFileTocRow | undefined) ?? null;
}

async function requireTocAdmin(pool: pg.Pool, request: FastifyRequest): Promise<CurrentUser> {
  const user = await getCurrentUser(pool, request.cookies);
  if (!user || !isActiveUser(user)) throw unauthorized();
  if (!canManageToc(user)) {
    throw forbidden('Chỉ quản trị viên mới quản lý được mục lục tài liệu');
  }
  return user;
}

function formatPublicTocResponse(row: DocFileTocRow, user: CurrentUser | null) {
  const fullAccess = canViewFull(user, row);
  const previewOnly = !fullAccess;
  const maxAccessiblePage = previewOnly ? (row.preview_pages ?? 0) : null;

  const hasValidManual =
    row.manual_override === true &&
    row.manual_payload !== null &&
    Array.isArray(row.manual_payload?.nodes);

  const mapNodeWithLock = (n: StoredTocNode, idx: number) => ({
    title: n.title,
    level: n.level,
    page_pdf: n.page_pdf,
    sort: Number.isInteger(n.sort) && n.sort > 0 ? n.sort : idx + 1,
    source: n.source,
    confidence: n.confidence,
    locked: previewOnly && n.page_pdf > (maxAccessiblePage ?? 0),
  });

  let state: 'ready' | 'processing' | 'failed' | 'unsupported' | 'not_enabled';
  let displayable = false;
  let effectiveSource: 'manual' | 'auto' | null = null;
  let status: TocStatus | null = null;
  let strategy: string | null = null;
  let flags: string[] = [];
  let offset: OffsetInfo | null = null;
  let needsOcrPages: number[] = [];
  let nodes: Array<ReturnType<typeof mapNodeWithLock>> = [];

  if (hasValidManual) {
    state = 'ready';
    displayable = true;
    effectiveSource = 'manual';
    status = 'ok';
    strategy = 'manual';
    flags = [];
    offset = row.auto_payload?.offset ?? null;
    needsOcrPages = row.auto_payload?.needsOcrPages ?? [];
    nodes = row.manual_payload!.nodes.map(mapNodeWithLock);
  } else if (
    row.mime_type !== PDF_MIME ||
    row.job_status === 'unsupported' ||
    row.auto_status === 'unsupported'
  ) {
    state = 'unsupported';
    effectiveSource = row.toc_file_id ? 'auto' : null;
    status = row.auto_status ?? 'unsupported';
    strategy = row.auto_strategy ?? 'unsupported';
  } else if (!row.toc_file_id) {
    state = 'not_enabled';
  } else if (row.job_status === 'pending' || row.job_status === 'processing') {
    state = 'processing';
  } else if (row.job_status === 'failed' || row.auto_status === 'failed') {
    state = 'failed';
    effectiveSource = 'auto';
    status = 'failed';
    strategy = row.auto_strategy ?? 'failed';
  } else {
    // job_status === 'done'
    state = 'ready';
    effectiveSource = 'auto';
    status = row.auto_status ?? row.auto_payload?.status ?? null;
    strategy = row.auto_strategy ?? row.auto_payload?.strategy ?? null;
    flags = row.auto_flags ?? row.auto_payload?.flags ?? [];
    offset = row.auto_payload?.offset ?? null;
    needsOcrPages = row.auto_payload?.needsOcrPages ?? [];
    // Bảo vệ hai lớp: CHỈ hiển thị cây tự động khi status === 'ok'.
    displayable = status === 'ok';
    if (displayable && Array.isArray(row.auto_payload?.nodes)) {
      nodes = row.auto_payload.nodes.map(mapNodeWithLock);
    }
  }

  return {
    state,
    payload: {
      document_id: row.doc_id,
      standard_id: row.standard_id,
      file: {
        id: row.file_id,
        version: row.version,
        version_label: row.version_label,
        uploaded_by: row.uploaded_by,
        uploaded_at: row.uploaded_at,
        page_count: row.page_count ?? row.auto_payload?.totalPages ?? null,
        preview_pages: row.preview_pages,
      },
      state,
      displayable,
      effective_source: effectiveSource,
      algorithm_version: row.algorithm_version ?? null,
      status,
      strategy,
      flags,
      offset,
      needs_ocr_pages: needsOcrPages,
      preview_only: previewOnly,
      max_accessible_page: maxAccessiblePage,
      nodes,
    },
  };
}

function sendPublicTocReply(
  row: DocFileTocRow | null,
  user: CurrentUser | null,
  reply: FastifyReply
) {
  if (!row || !row.file_id) throw notFound();
  if (!canPreview(user, row)) {
    // Chưa đăng nhập: 404 thống nhất để không lộ tài liệu tồn tại.
    if (!user) throw notFound();
    throw forbidden('Bạn không có quyền xem tài liệu này');
  }

  const formatted = formatPublicTocResponse(row, user);
  const isPublic = row.status === 'published' && row.visibility === 'public';
  if (isPublic && formatted.state !== 'processing') {
    reply.header('Cache-Control', 'public, max-age=60');
  } else {
    reply.header('Cache-Control', 'private, no-store');
  }
  return reply.send(formatted.payload);
}

/** Đăng ký route đọc mục lục công khai/nội bộ và route quản trị mục lục. */
export function registerTocRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  _cfg: AppConfig
): void {
  app.get(
    '/api/documents/:id/toc',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!isValidUuid(id)) throw notFound();

      const row = await loadCurrentDocFileToc(pool, id);
      const user = await getCurrentUser(pool, request.cookies);
      return sendPublicTocReply(row, user, reply);
    }
  );

  app.get(
    '/api/documents/:id/files/:fileId/toc',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id, fileId } = request.params as { id: string; fileId: string };
      if (!isValidUuid(id) || !isValidUuid(fileId)) throw notFound();

      const row = await loadSpecificDocFileToc(pool, id, fileId);
      const user = await getCurrentUser(pool, request.cookies);
      return sendPublicTocReply(row, user, reply);
    }
  );

  app.get('/api/admin/tocs', async (request, reply) => {
    await requireTocAdmin(pool, request);
    const parsed = adminListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_QUERY', 'Tham số truy vấn danh sách mục lục không hợp lệ.');
    }
    const q = parsed.data;
    const params: unknown[] = [];
    const where: string[] = ['df.mime_type = $1'];
    params.push(PDF_MIME);

    if (q.auto_status) {
      params.push(q.auto_status);
      where.push(`t.auto_status = $${params.length}`);
    }
    if (q.flag) {
      params.push(q.flag);
      where.push(`$${params.length} = ANY(t.auto_flags)`);
    }
    if (q.job_status) {
      params.push(q.job_status);
      where.push(`t.job_status = $${params.length}`);
    }
    if (q.manual_override !== undefined) {
      params.push(q.manual_override);
      where.push(`COALESCE(t.manual_override, false) = $${params.length}`);
    }
    if (q.standards_only === true) {
      where.push('d.standard_id IS NOT NULL');
    } else if (q.standards_only === false) {
      where.push('d.standard_id IS NULL');
    }
    if (q.outdated_algorithm === true) {
      params.push(TOC_ALGORITHM_VERSION);
      where.push(`t.algorithm_version IS DISTINCT FROM $${params.length}`);
    }

    const whereSql = where.join(' AND ');
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM document_files df
       JOIN documents d ON d.id = df.document_id
       LEFT JOIN document_file_tocs t ON t.file_id = df.id
       WHERE ${whereSql}`,
      params
    );
    const total = Number((countRes.rows[0] as { total: number } | undefined)?.total ?? 0);

    const listParams = [...params, q.limit, q.offset];
    const listRes = await pool.query(
      `SELECT df.id AS file_id, df.document_id, df.version, df.version_label,
              df.uploaded_by, df.uploaded_at, df.original_filename, df.mime_type, df.page_count,
              d.title AS document_title, d.standard_id,
              (d.current_file_id = df.id) AS is_current_version,
              s.code_display AS standard_code_display,
              t.job_status, t.attempts, t.last_error, t.auto_status, t.auto_strategy,
              t.auto_flags, t.algorithm_version, t.extracted_at,
              COALESCE(t.manual_override, false) AS manual_override,
              t.manual_updated_by, t.manual_updated_at
       FROM document_files df
       JOIN documents d ON d.id = df.document_id
       LEFT JOIN standards s ON s.id = d.standard_id
       LEFT JOIN document_file_tocs t ON t.file_id = df.id
       WHERE ${whereSql}
       ORDER BY df.uploaded_at DESC, df.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      data: listRes.rows,
      total,
      limit: q.limit,
      offset: q.offset,
      current_algorithm_version: TOC_ALGORITHM_VERSION,
    });
  });

  app.get('/api/admin/files/:fileId/toc', async (request, reply) => {
    await requireTocAdmin(pool, request);
    const { fileId } = request.params as { fileId: string };
    if (!isValidUuid(fileId)) throw notFound('Không tìm thấy file tài liệu');

    const row = await loadAdminFileToc(pool, fileId);
    if (!row) throw notFound('Không tìm thấy file tài liệu');

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      file_id: row.file_id,
      document_id: row.document_id,
      document_title: row.document_title,
      standard_id: row.standard_id,
      standard_code_display: row.standard_code_display,
      is_current_version: row.current_file_id === row.file_id,
      version: row.version,
      version_label: row.version_label,
      uploaded_by: row.uploaded_by,
      uploaded_at: row.uploaded_at,
      original_filename: row.original_filename,
      mime_type: row.mime_type,
      page_count: row.page_count,
      job_status: row.job_status,
      attempts: row.attempts ?? 0,
      locked_at: row.locked_at,
      last_error: row.last_error,
      auto_status: row.auto_status,
      auto_strategy: row.auto_strategy,
      auto_flags: row.auto_flags ?? [],
      algorithm_version: row.algorithm_version,
      extracted_at: row.extracted_at,
      auto_payload: row.auto_payload,
      manual_override: row.manual_override === true,
      manual_payload: row.manual_payload,
      manual_updated_by: row.manual_updated_by,
      manual_updated_at: row.manual_updated_at,
      current_algorithm_version: TOC_ALGORITHM_VERSION,
    });
  });

  app.put('/api/admin/files/:fileId/toc/manual', async (request, reply) => {
    const user = await requireTocAdmin(pool, request);
    const { fileId } = request.params as { fileId: string };
    if (!isValidUuid(fileId)) throw notFound('Không tìm thấy file tài liệu');

    const parsed = putManualSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest(
        'INVALID_TOC_NODES',
        'Dữ liệu mục lục không hợp lệ (tối đa 2000 mục, level 1..6, page_pdf >= 1).'
      );
    }

    const row = await loadAdminFileToc(pool, fileId);
    if (!row) throw notFound('Không tìm thấy file tài liệu');

    const totalPages = row.page_count ?? row.auto_payload?.totalPages ?? null;
    const beforeCount = Array.isArray(row.manual_payload?.nodes)
      ? row.manual_payload.nodes.length
      : 0;

    const normalizedNodes: StoredTocNode[] = [];
    for (let idx = 0; idx < parsed.data.nodes.length; idx++) {
      const n = parsed.data.nodes[idx];
      const title = normalizeUnicode(n.title).trim();
      if (!title || title.length > DEFAULT_TOC_LIMITS.maxTitleLength) {
        throw badRequest(
          'INVALID_TOC_TITLE',
          `Tiêu đề mục #${idx + 1} rỗng hoặc vượt quá ${DEFAULT_TOC_LIMITS.maxTitleLength} ký tự.`
        );
      }
      if (totalPages === null || totalPages < 1 || n.page_pdf > totalPages) {
        throw badRequest(
          'INVALID_PAGE_RANGE',
          totalPages === null
            ? 'Chưa xác định được tổng số trang của PDF để kiểm tra phạm vi trang.'
            : `Số trang mục #${idx + 1} (${n.page_pdf}) vượt ngoài phạm vi 1..${totalPages}.`
        );
      }
      normalizedNodes.push({
        title,
        level: n.level,
        page_pdf: n.page_pdf,
        sort: idx + 1,
        source: 'manual',
        confidence: 1.0,
      });
    }

    const manualPayload: TocManualPayload = {
      schemaVersion: TOC_SCHEMA_VERSION,
      updatedFromAlgorithmVersion: row.algorithm_version ?? null,
      note: parsed.data.note ?? null,
      nodes: normalizedNodes,
    };

    const initialJobStatus: TocJobStatus = row.mime_type === PDF_MIME ? 'pending' : 'unsupported';
    await pool.query(
      `INSERT INTO document_file_tocs
         (file_id, job_status, manual_override, manual_payload, manual_updated_by, manual_updated_at, updated_at)
       VALUES ($1, $2, true, $3::jsonb, $4, now(), now())
       ON CONFLICT (file_id) DO UPDATE SET
         manual_override = true,
         manual_payload = EXCLUDED.manual_payload,
         manual_updated_by = EXCLUDED.manual_updated_by,
         manual_updated_at = EXCLUDED.manual_updated_at,
         updated_at = now()`,
      [fileId, initialJobStatus, JSON.stringify(manualPayload), user.id]
    );

    request.log.info(
      {
        audit: 'toc_manual_updated',
        userId: user.id,
        documentId: row.document_id,
        fileId,
        version: row.version,
        nodeCountBefore: beforeCount,
        nodeCountAfter: normalizedNodes.length,
        manualOverride: true,
      },
      'toc manual updated'
    );

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      ok: true,
      file_id: fileId,
      manual_override: true,
      manual_payload: manualPayload,
    });
  });

  app.post('/api/admin/files/:fileId/toc/promote-auto', async (request, reply) => {
    const user = await requireTocAdmin(pool, request);
    const { fileId } = request.params as { fileId: string };
    if (!isValidUuid(fileId)) throw notFound('Không tìm thấy file tài liệu');

    const parsed = promoteAutoSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Tham số chuyển mục lục tự động không hợp lệ.');
    }

    const row = await loadAdminFileToc(pool, fileId);
    if (!row) throw notFound('Không tìm thấy file tài liệu');

    const autoNodes = row.auto_payload?.nodes;
    if (!Array.isArray(autoNodes) || autoNodes.length === 0) {
      throw badRequest(
        'TOC_AUTO_NOT_AVAILABLE',
        'Chưa có cây mục lục tự động để chuyển sang bản chỉnh tay.'
      );
    }

    const beforeCount = Array.isArray(row.manual_payload?.nodes)
      ? row.manual_payload.nodes.length
      : 0;
    const clonedNodes: StoredTocNode[] = autoNodes.map((n, idx) => ({
      title: n.title,
      level: n.level,
      page_pdf: n.page_pdf,
      sort: idx + 1,
      source: n.source,
      confidence: n.confidence,
    }));

    const manualPayload: TocManualPayload = {
      schemaVersion: TOC_SCHEMA_VERSION,
      updatedFromAlgorithmVersion: row.algorithm_version ?? null,
      note: parsed.data.note ?? null,
      nodes: clonedNodes,
    };

    const activate = parsed.data.activate;
    await pool.query(
      `UPDATE document_file_tocs
       SET manual_override = $2,
           manual_payload = $3::jsonb,
           manual_updated_by = $4,
           manual_updated_at = now(),
           updated_at = now()
       WHERE file_id = $1`,
      [fileId, activate, JSON.stringify(manualPayload), user.id]
    );

    request.log.info(
      {
        audit: 'toc_auto_promoted',
        userId: user.id,
        documentId: row.document_id,
        fileId,
        version: row.version,
        nodeCountBefore: beforeCount,
        nodeCountAfter: clonedNodes.length,
        manualOverride: activate,
      },
      'toc auto promoted to manual'
    );

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      ok: true,
      file_id: fileId,
      manual_override: activate,
      manual_payload: manualPayload,
    });
  });

  app.delete('/api/admin/files/:fileId/toc/manual', async (request, reply) => {
    const user = await requireTocAdmin(pool, request);
    const { fileId } = request.params as { fileId: string };
    if (!isValidUuid(fileId)) throw notFound('Không tìm thấy file tài liệu');

    const row = await loadAdminFileToc(pool, fileId);
    if (!row) throw notFound('Không tìm thấy file tài liệu');

    const beforeCount = Array.isArray(row.manual_payload?.nodes)
      ? row.manual_payload.nodes.length
      : 0;

    if (row.toc_file_id) {
      await pool.query(
        `UPDATE document_file_tocs
         SET manual_override = false,
             manual_payload = NULL,
             manual_updated_by = $2,
             manual_updated_at = now(),
             updated_at = now()
         WHERE file_id = $1`,
        [fileId, user.id]
      );
    }

    request.log.info(
      {
        audit: 'toc_manual_deleted',
        userId: user.id,
        documentId: row.document_id,
        fileId,
        version: row.version,
        nodeCountBefore: beforeCount,
        nodeCountAfter: 0,
        manualOverride: false,
      },
      'toc manual override cleared'
    );

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({ ok: true, file_id: fileId, manual_override: false });
  });

  app.post('/api/admin/files/:fileId/toc/reextract', async (request, reply) => {
    const user = await requireTocAdmin(pool, request);
    const { fileId } = request.params as { fileId: string };
    if (!isValidUuid(fileId)) throw notFound('Không tìm thấy file tài liệu');

    const row = await loadAdminFileToc(pool, fileId);
    if (!row) throw notFound('Không tìm thấy file tài liệu');

    if (row.mime_type !== PDF_MIME) {
      throw badRequest(
        'TOC_UNSUPPORTED_FORMAT',
        'Chỉ hỗ trợ trích xuất lại mục lục cho file PDF.'
      );
    }

    await pool.query(
      `INSERT INTO document_file_tocs (file_id, job_status, attempts, locked_at, last_error, updated_at)
       VALUES ($1, 'pending', 0, NULL, NULL, now())
       ON CONFLICT (file_id) DO UPDATE SET
         job_status = 'pending',
         attempts = 0,
         locked_at = NULL,
         last_error = NULL,
         updated_at = now()`,
      [fileId]
    );

    request.log.info(
      {
        audit: 'toc_reextract_requested',
        userId: user.id,
        documentId: row.document_id,
        fileId,
        version: row.version,
        manualOverride: row.manual_override === true,
      },
      'toc reextract queued'
    );

    reply.header('Cache-Control', 'private, no-store');
    return reply.send({
      ok: true,
      file_id: fileId,
      job_status: 'pending',
      manual_override: row.manual_override === true,
    });
  });
}
