import { isActiveUser, type CurrentUser } from '../auth/session.js';

/**
 * Quyền quản lý / chỉnh sửa mục lục thủ công và kích hoạt trích xuất lại:
 * Giai đoạn đầu chỉ cho phép quản trị viên (status='active', role='admin'),
 * khớp quyền đổi phiên bản hiện hành ở Phase A. Mở rộng thêm cho editor về
 * sau chỉ cần cập nhật đúng một hàm tập trung này.
 */
export function canManageToc(user: CurrentUser | null): boolean {
  return isActiveUser(user) && user.role === 'admin';
}
