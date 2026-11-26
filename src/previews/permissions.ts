import {
  canDownloadOriginal,
  isActiveUser,
  type CurrentUser,
  type DocumentAccessRow
} from '../auth/session.js';
import { visibleInList } from '../documents/visibility.js';

/**
 * Quyền xem bản xem trước = quyền "thấy tài liệu" theo ma trận hiện có
 * (visibleInList / canDownload):
 * - published + public: mọi người, kể cả chưa đăng nhập.
 * - published + members: mọi tài khoản đã đăng nhập và status=active (gồm cả external).
 * - published + internal: CHỈ người nội bộ (user_type=internal) hoặc editor/admin (status=active).
 * - published + private: người tạo hoặc admin (status=active).
 * - draft/hidden: người tạo, editor, admin (status=active).
 */
export function canPreview(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  return visibleInList(user, doc);
}

/**
 * Quyền xem TOÀN BỘ online (/view): người tạo tài liệu + admin (chung quy
 * tắc canDownloadOriginal với quyền tải bản gốc). Riêng FILE TIÊU CHUẨN
 * đã mua (doc.standard_id có giá trị): người trong tổ chức
 * (user_type=internal, status=active) cũng được xem toàn bộ trong viewer
 * khi tài liệu đang hiển thị với họ theo ma trận danh sách — nhưng tải
 * bản gốc (.../download) vẫn CHỈ người tạo + admin, không đổi.
 */
export function canViewFull(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  if (canDownloadOriginal(user, doc)) return true;
  if (!doc.standard_id) return false;
  return isActiveUser(user) && user.userType === 'internal' && visibleInList(user, doc);
}
