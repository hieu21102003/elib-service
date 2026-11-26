import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import type { CurrentUser } from '../auth/session.js';
import { getCurrentUser } from './auth.js';
import { lightNormalizeCode } from '../standards/light-normalize.js';
import {
  findStandardByCode,
  listStandardRelations,
  upsertManualStandard,
  type LookupRelation,
  type ManualStandardInput,
  type StandardRow
} from '../standards/repository.js';

/**
 * API quản trị metadata tiêu chuẩn (chỉ admin, phiên đăng nhập — KHÔNG
 * dùng X-Internal-Token của /internal/standards/*):
 * - GET /api/admin/standards/:code — tải bản ghi hiện tại cho form sửa
 *   (404 khi chưa có; khớp hai khóa normalized_code/code_key_raw).
 * - PUT /api/admin/standards/:code — lưu tay (upsert): có bản ghi thì
 *   cập nhật các trường được gửi, chưa có thì tạo mới; luôn đặt
 *   detail_level='manual' nên ingest từ VSQI/TCVN_VN/TCVN_QT không ghi
 *   đè được nữa. Mã không chuẩn hóa được -> 400 INVALID_STANDARD_CODE.
 * CSRF dùng chung hook /api/* trong app.ts (kiểm tra Origin cho PUT).
 * Mọi lần lưu đều ghi audit log.
 */

const codeParamSchema = z.string().trim().min(1).max(200);

const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const dateFieldSchema = z
  .string()
  .trim()
  .max(10)
  .refine((v) => v === '' || DATE_RE.test(v), 'Ngày phải có dạng YYYY, YYYY-MM hoặc YYYY-MM-DD');

const relationInputSchema = z.union([
  z.string().max(5000),
  z.array(z.string().trim().min(1).max(500)).max(100)
]);

const putBodySchema = z.object({
  year: z.number().int().min(1000).max(9999).nullable().optional(),
  title_vi: z.string().max(2000).nullable().optional(),
  title_en: z.string().max(2000).nullable().optional(),
  status: z.enum(['Active', 'Withdrawn', 'Unknown']).nullable().optional(),
  issued_date: dateFieldSchema.nullable().optional(),
  effective_date: dateFieldSchema.nullable().optional(),
  ics: z.array(z.string().trim().min(1).max(50)).max(50).nullable().optional(),
  replaces: relationInputSchema.nullable().optional(),
  replaced_by: relationInputSchema.nullable().optional()
});

async function requireAdmin(pool: pg.Pool, request: FastifyRequest): Promise<CurrentUser> {
  const user = await getCurrentUser(pool, request.cookies);
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('Chỉ quản trị viên mới thực hiện được thao tác này');
  return user;
}

function edgeCode(r: LookupRelation): string {
  return r.other_code_display ?? r.other_normalized_code ?? r.to_code_raw;
}

function mapStandard(row: StandardRow, relations: LookupRelation[]) {
  return {
    id: row.id,
    code: row.code_display,
    normalized_code: row.normalized_code,
    base_key: row.base_key,
    code_key_raw: row.code_key_raw,
    org: row.org,
    number: row.number,
    part: row.part,
    year: row.year,
    amendment: row.amendment,
    suffix: row.suffix,
    title_vi: row.title_vi,
    title_en: row.title_en,
    status: row.status,
    issued_date: row.issued_date,
    effective_date: row.effective_date,
    ics: row.ics,
    detail_level: row.detail_level,
    parse_confidence: row.parse_confidence !== null ? Number(row.parse_confidence) : null,
    is_amendment: row.is_amendment,
    amendment_year: row.amendment_year,
    is_draft: row.is_draft,
    needs_review: row.needs_review,
    replaces: relations
      .filter((r) => r.direction === 'outgoing' && r.type === 'replaces')
      .map(edgeCode),
    replaced_by: relations
      .filter((r) => r.direction === 'incoming' && r.type === 'replaces')
      .map(edgeCode),
    last_verified_at: row.last_verified_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString()
  };
}

function parseCodeParam(raw: string): string {
  const parsed = codeParamSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('INVALID_STANDARD_CODE', 'Mã tiêu chuẩn không hợp lệ.');
  }
  return parsed.data;
}

export function registerAdminStandardRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/api/admin/standards/:code', async (request, reply) => {
    await requireAdmin(pool, request);
    const { code: rawCode } = request.params as { code: string };
    const code = parseCodeParam(rawCode);
    const light = lightNormalizeCode(code);
    if (light === null || light.normalized_code === null) {
      throw badRequest('INVALID_STANDARD_CODE', 'Mã tiêu chuẩn không chuẩn hóa được.');
    }
    const standard = await findStandardByCode(pool, code);
    if (!standard) throw notFound('Không tìm thấy tiêu chuẩn');
    const relations = await listStandardRelations(pool, standard.id);
    return reply.send({ standard: mapStandard(standard, relations) });
  });

  app.put('/api/admin/standards/:code', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { code: rawCode } = request.params as { code: string };
    const code = parseCodeParam(rawCode);
    const parsed = putBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.');
    }
    const input: ManualStandardInput = { code, ...parsed.data };
    const result = await upsertManualStandard(pool, input);
    if (!result.ok) {
      throw badRequest('INVALID_STANDARD_CODE', 'Mã tiêu chuẩn không chuẩn hóa được.');
    }
    const relations = await listStandardRelations(pool, result.standard.id);
    request.log.info(
      {
        audit: 'standard_manual_saved',
        adminId: admin.id,
        standardId: result.standard.id,
        normalizedCode: result.standard.normalized_code,
        created: result.created,
        fields: Object.keys(parsed.data)
      },
      'manual standard metadata saved'
    );
    return reply.send({
      standard: mapStandard(result.standard, relations),
      created: result.created
    });
  });
}
