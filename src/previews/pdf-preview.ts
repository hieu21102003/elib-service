import { PDFDocument } from 'pdf-lib';

/**
 * Xử lý PDF cho bản xem trước bằng pdf-lib:
 * - Đếm trang của bản gốc.
 * - Tạo PDFDocument MỚI và copyPages các trang đầu sang (KHÔNG dùng
 *   removePage trên bản gốc). Document mới không mang theo metadata,
 *   outline, attachment hay XMP của bản gốc; Info dict được đặt rỗng.
 */

export interface BuiltPreview {
  bytes: Uint8Array;
  totalPages: number;
  previewPages: number;
}

/** Đếm số trang của một PDF (ném lỗi nếu PDF hỏng/mã hóa). */
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return doc.getPageCount();
}

/**
 * Cắt `previewPages` trang đầu của PDF gốc thành một PDF mới độc lập.
 * Ném lỗi nếu PDF hỏng/mã hóa hoặc số trang không hợp lệ.
 */
export async function buildPreviewPdf(
  originalBytes: Uint8Array,
  previewPages: number
): Promise<BuiltPreview> {
  const source = await PDFDocument.load(originalBytes, { ignoreEncryption: false });
  const totalPages = source.getPageCount();
  if (!Number.isInteger(previewPages) || previewPages < 1 || previewPages >= totalPages) {
    throw new Error(
      `Số trang xem trước không hợp lệ: ${previewPages} (tổng ${totalPages} trang)`
    );
  }

  const preview = await PDFDocument.create();
  const indices = Array.from({ length: previewPages }, (_, i) => i);
  const copied = await preview.copyPages(source, indices);
  for (const page of copied) {
    preview.addPage(page);
  }

  // Info dict rỗng: không để lộ metadata của bản gốc qua bản xem trước.
  preview.setTitle('');
  preview.setAuthor('');
  preview.setSubject('');
  preview.setKeywords([]);
  preview.setProducer('');
  preview.setCreator('');

  const bytes = await preview.save();
  return { bytes, totalPages, previewPages };
}
