import { z } from 'zod';
import { badRequest } from '../errors.js';

export interface DocumentListQuery {
  q?: string;
  categoryId?: string;
  limit: number;
  offset: number;
}

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 50;

/**
 * Query thô của GET /api/documents: mọi tham số đều là chuỗi (hoặc bị từ chối
 * nếu gửi trùng thành mảng). q tối đa 200 ký tự; category_id phải là UUID.
 */
const rawListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  category_id: z.string().uuid().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

/** Kẹp limit vào khoảng [1, 50] thay vì báo lỗi khi vượt khoảng. */
export function clampLimit(value: number): number {
  return Math.min(LIST_LIMIT_MAX, Math.max(LIST_LIMIT_MIN, value));
}

function parseNonNegativeInt(raw: string, field: string): number {
  if (!/^\d+$/.test(raw)) {
    throw badRequest('INVALID_QUERY', `Tham số ${field} không hợp lệ.`);
  }
  return Number(raw);
}

/**
 * Phân tích + kiểm tra query của GET /api/documents.
 * - q: tùy chọn, tối đa 200 ký tự (vượt -> 400).
 * - category_id: tùy chọn, phải là UUID (sai -> 400).
 * - limit: mặc định 20; không phải số nguyên không âm -> 400; ngoài [1, 50] thì kẹp lại.
 * - offset: mặc định 0; âm hoặc không phải số -> 400.
 */
export function parseDocumentListQuery(raw: unknown): DocumentListQuery {
  const parsed = rawListQuerySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw badRequest('INVALID_QUERY', 'Tham số truy vấn không hợp lệ. Vui lòng kiểm tra lại.');
  }
  const { q, category_id, limit, offset } = parsed.data;
  return {
    q,
    categoryId: category_id,
    limit: limit === undefined ? LIST_LIMIT_DEFAULT : clampLimit(parseNonNegativeInt(limit, 'limit')),
    offset: offset === undefined ? 0 : parseNonNegativeInt(offset, 'offset')
  };
}
