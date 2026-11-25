import { EncryptedPDFError, PDFDocument } from 'pdf-lib';

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

const ENCRYPT_TAIL_BYTES = 128 * 1024;
const ENCRYPT_MARKER_RE = /\/Encrypt(?:\s+\d+\s+\d+\s+R|\s*<<)/;

/** Kiểm tra lỗi do pdf-lib ném ra có phải vì PDF được mã hóa hay không. */
export function isEncryptedPdfError(err: unknown): boolean {
  if (err instanceof EncryptedPDFError) return true;
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'EncryptedPDFError' ||
    /(?:PDFDocument\.load|document).*is encrypted/i.test(err.message)
  );
}

/**
 * Kiểm tra dấu hiệu `/Encrypt` trong phần đuôi PDF (tối đa 128 KB cuối),
 * để nhận diện PDF 1.5+ có ObjStm mã hóa khiến pdf-lib lỗi parse trước bước
 * kiểm tra trailer.
 */
export function hasPdfEncryptMarker(bytes: Uint8Array): boolean {
  const start = Math.max(0, bytes.length - ENCRYPT_TAIL_BYTES);
  const slice = bytes.subarray(start);
  const tail = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('latin1');
  return ENCRYPT_MARKER_RE.test(tail);
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
