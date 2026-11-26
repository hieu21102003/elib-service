import {
  canAccessInternal,
  canAccessMembers,
  isActiveUser,
  type CurrentUser,
  type DocumentAccessRow
} from '../auth/session.js';

/** Mảnh SQL + tham số đi kèm, dùng để ghép vào câu truy vấn lớn hơn. */
export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * Điều kiện lọc quyền xem tài liệu trong danh sách (GET /api/documents),
 * áp dụng NGAY TRONG SQL cho cả truy vấn danh sách lẫn truy vấn đếm tổng (total),
 * để tài liệu không có quyền xem không lộ qua kết quả hay qua số lượng.
 *
 * Phải khớp CHÍNH XÁC ma trận của canDownload() trong src/auth/session.ts:
 * - published + public: mọi người (kể cả chưa đăng nhập).
 * - published + members: mọi tài khoản đã đăng nhập và status=active (gồm cả external).
 * - published + internal: CHỈ người nội bộ (user_type=internal) hoặc editor/admin (status=active).
 * - published + private: người tạo hoặc admin (status=active).
 * - draft/hidden: người tạo, editor, admin (status=active).
 *
 * Chưa đăng nhập (hoặc tài khoản không active) = userId NULL, role NULL, userType NULL.
 * Tham số được đánh số từ `startParam` (userId, role, userType) để ghép được với các
 * điều kiện khác trong cùng câu SQL. `alias` là alias của bảng documents (mặc định 'd').
 */
export function visibleDocumentsWhere(
  user: CurrentUser | null,
  startParam = 1,
  alias = 'd'
): SqlFragment {
  const active = isActiveUser(user) ? user : null;
  const uid = `$${startParam}`;
  const role = `$${startParam + 1}`;
  const userType = `$${startParam + 2}`;
  const sql = `(
    (${alias}.status = 'published' AND ${alias}.visibility = 'public')
    OR (${alias}.status = 'published' AND ${alias}.visibility = 'members' AND ${uid}::uuid IS NOT NULL)
    OR (${alias}.status = 'published' AND ${alias}.visibility = 'internal' AND ${uid}::uuid IS NOT NULL AND (${userType}::text = 'internal' OR ${role}::text IN ('editor', 'admin')))
    OR (${alias}.status = 'published' AND ${alias}.visibility = 'private' AND (${uid}::uuid = ${alias}.created_by OR ${role}::text = 'admin'))
    OR (${alias}.status IN ('draft', 'hidden') AND (${uid}::uuid = ${alias}.created_by OR ${role}::text IN ('editor', 'admin')))
  )`;
  return { sql, params: [active?.id ?? null, active?.role ?? null, active?.userType ?? null] };
}

/**
 * Bản sao logic của visibleDocumentsWhere ở phía JS (cùng ma trận với canDownload),
 * dùng để test đối chiếu và cho các trường hợp cần kiểm tra một tài liệu đơn lẻ.
 * Với status ngoài tập hợp lệ (DB đã chặn bằng CHECK) hàm trả false — chặt hơn
 * canDownload một chút, không ảnh hưởng dữ liệu thật.
 */
export function visibleInList(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  const active = isActiveUser(user) ? user : null;
  const isOwner = !!active && active.id === doc.created_by;
  const role = active?.role ?? null;
  if (doc.status === 'published' && doc.visibility === 'public') return true;
  if (doc.status === 'published' && doc.visibility === 'members') return canAccessMembers(active);
  if (doc.status === 'published' && doc.visibility === 'internal') return canAccessInternal(active);
  if (doc.status === 'published' && doc.visibility === 'private') {
    return isOwner || role === 'admin';
  }
  if (doc.status === 'draft' || doc.status === 'hidden') {
    return isOwner || role === 'editor' || role === 'admin';
  }
  return false;
}
