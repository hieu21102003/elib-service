/** Lỗi nghiệp vụ có mã ổn định + thông điệp tiếng Việt cho người dùng. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, messageVi: string, details?: unknown) {
    super(messageVi);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, messageVi: string, details?: unknown): AppError {
  return new AppError(400, code, messageVi, details);
}
export function unauthorized(messageVi = 'Bạn cần đăng nhập để thực hiện thao tác này'): AppError {
  return new AppError(401, 'UNAUTHORIZED', messageVi);
}
export function forbidden(messageVi = 'Bạn không có quyền thực hiện thao tác này'): AppError {
  return new AppError(403, 'FORBIDDEN', messageVi);
}
export function notFound(messageVi = 'Không tìm thấy tài liệu'): AppError {
  return new AppError(404, 'NOT_FOUND', messageVi);
}
export function conflict(code: string, messageVi: string, details?: unknown): AppError {
  return new AppError(409, code, messageVi, details);
}
