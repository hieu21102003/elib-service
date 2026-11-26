import { canDownloadOriginal, type CurrentUser, type DocumentAccessRow } from '../auth/session.js';
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
 * Quyền xem TOÀN BỘ online (/view): CHỈ người tạo tài liệu + admin.
 * Dùng chung quy tắc với quyền tải bản gốc (canDownloadOriginal) để
 * /view và .../download không bao giờ lệch nhau; khi thêm quyền người
 * đã mua, chỉ sửa canDownloadOriginal.
 */
export function canViewFull(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  return canDownloadOriginal(user, doc);
}
