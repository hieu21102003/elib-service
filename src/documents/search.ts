import type { SqlFragment } from './visibility.js';

/**
 * Escape các ký tự đặc biệt của LIKE/ILIKE trong từ khóa người dùng nhập,
 * để %, _ và \ được hiểu theo nghĩa đen (dùng kèm ESCAPE '\' trong SQL).
 * Phải escape dấu \ trước, rồi mới tới % và _.
 */
export function escapeLikeKeyword(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Điều kiện tìm kiếm không dấu (accent-insensitive) trên 3 trường:
 * tiêu đề (title), mô tả (description) và thẻ (tags). KHÔNG tìm trong nội dung file.
 *
 * Dùng hàm f_unaccent() (migration 002_search.sql) + lower() ở cả hai vế để
 * "duong sat" khớp "Đường sắt". Trả null khi từ khóa trống (chỉ khoảng trắng)
 * để route bỏ qua điều kiện này.
 *
 * Tham số pattern được đánh số `startParam`; `alias` là alias của bảng documents.
 */
export function searchPredicate(
  q: string | undefined,
  startParam: number,
  alias = 'd'
): SqlFragment | null {
  const trimmed = (q ?? '').trim();
  if (!trimmed) return null;
  const patternParam = `f_unaccent(lower($${startParam}))`;
  const sql = `(
    f_unaccent(lower(${alias}.title)) LIKE ${patternParam} ESCAPE '\\'
    OR f_unaccent(lower(COALESCE(${alias}.description, ''))) LIKE ${patternParam} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM document_tags dt
      JOIN tags t ON t.id = dt.tag_id
      WHERE dt.document_id = ${alias}.id
        AND f_unaccent(lower(t.name)) LIKE ${patternParam} ESCAPE '\\'
    )
  )`;
  return { sql, params: [`%${escapeLikeKeyword(trimmed)}%`] };
}
