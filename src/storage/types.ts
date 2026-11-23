import type { Readable } from 'node:stream';

/**
 * Lớp lưu trữ duy nhất mà toàn bộ code được phép gọi.
 * Giai đoạn 1: LocalDiskStorage (ổ đĩa máy công ty).
 * Sau này đổi sang S3/MinIO chỉ cần viết implementation mới theo interface này.
 *
 * Mọi đường dẫn truyền vào/nhận ra đều là đường dẫn TƯƠNG ĐỐI so với STORAGE_ROOT
 * (ví dụ: "originals/<doc_id>/v1/<file_id>.pdf"). DB chỉ lưu đường dẫn tương đối.
 */
export interface StorageService {
  /**
   * Lưu một stream vào đường dẫn tương đối đích.
   * Implementation phải ghi qua thư mục tạm rồi mới chuyển vào chỗ chính thức,
   * và tự dọn dẹp nếu lỗi giữa chừng.
   */
  save(stream: Readable, relativePath: string): Promise<void>;
  /** Mở stream đọc cho một file đã lưu. Ném lỗi nếu không tồn tại. */
  open(relativePath: string): Promise<Readable>;
  /** Xóa file (không lỗi nếu file không tồn tại). */
  delete(relativePath: string): Promise<void>;
  /** Kiểm tra file có tồn tại không. */
  exists(relativePath: string): Promise<boolean>;
  /**
   * Ghi một Buffer/Uint8Array vào đường dẫn tương đối đích (qua file tạm +
   * rename nguyên tử, giống save). Dùng cho file xem trước do job sinh ra.
   */
  saveBytes(bytes: Uint8Array, relativePath: string): Promise<void>;
  /**
   * Đọc toàn bộ file thành Buffer, có trần kích thước: vượt trần thì ném lỗi
   * thay vì nạp hết vào RAM. Dùng cho job xử lý PDF.
   */
  readBytes(relativePath: string, maxBytes: number): Promise<Buffer>;
}

/** Dựng đường dẫn tương đối chuẩn cho file gốc. Luôn qua path.join ở implementation. */
export function originalRelativePathParts(docId: string, version: number, fileId: string, ext: string): string[] {
  const cleanExt = ext.replace(/^\./, '').toLowerCase();
  return ['originals', docId, `v${version}`, `${fileId}.${cleanExt}`];
}

/** Dựng đường dẫn tương đối chuẩn cho file xem trước (PDF đã cắt trang). */
export function previewRelativePathParts(docId: string, version: number): string[] {
  return ['previews', docId, `v${version}`, 'preview.pdf'];
}
