import type { CurrentUser, DocumentAccessRow } from '../auth/session.js';
import { visibleInList } from '../documents/visibility.js';

/**
 * Quyền xem bản xem trước = quyền "thấy tài liệu" theo ma trận hiện có
 * (visibleInList / canDownload):
 * - published + public: mọi người, kể cả chưa đăng nhập.
 * - published + internal: người dùng đã đăng nhập.
 * - published + private: người tạo hoặc admin.
 * - draft/hidden: người tạo, editor, admin.
 */
export function canPreview(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  return visibleInList(user, doc);
}

/**
 * Quyền xem TOÀN BỘ online (/view): CHỈ người tạo tài liệu + admin.
 * Editor KHÔNG có quyền này (dù editor vẫn giữ quyền tải bản gốc theo
 * canDownload hiện có — xem ghi chú trong báo cáo Giai đoạn A).
 */
export function canViewFull(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  if (!user) return false;
  return user.id === doc.created_by || user.role === 'admin';
}
