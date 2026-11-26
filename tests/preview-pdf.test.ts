import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, decodePDFRawStream, PDFName, PDFArray, PDFDict, PDFRawStream } from 'pdf-lib';
import { buildPreviewPdf, countPdfPages } from '../src/previews/pdf-preview.js';

/** Tạo PDF test: mỗi trang chứa chuỗi đánh dấu riêng "PAGE-MARKER-<n>". */
async function makeMarkedPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Tieu de bi mat cua ban goc');
  doc.setAuthor('Tac gia bi mat');
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`PAGE-MARKER-${i}`, { x: 50, y: 300, size: 14, font });
  }
  return doc.save();
}

/** Trích text thô từ các content stream của mọi trang (đã giải nén). */
async function extractAllText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const chunks: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFRawStream) {
      streams.push(contents);
    } else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const item = contents.lookup(i);
        if (item instanceof PDFRawStream) streams.push(item);
      }
    }
    for (const stream of streams) {
      const decoded = decodePDFRawStream(stream).decode();
      const raw = Buffer.from(decoded).toString('latin1');
      chunks.push(raw);
      // pdf-lib mã hóa text dạng hex string <50414745...> Tj — giải mã để tìm marker.
      for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        chunks.push(Buffer.from(match[1], 'hex').toString('latin1'));
      }
    }
  }
  return chunks.join('\n');
}

describe('countPdfPages + buildPreviewPdf', () => {
  it('đếm đúng số trang', async () => {
    const bytes = await makeMarkedPdf(7);
    await expect(countPdfPages(bytes)).resolves.toBe(7);
  });

  it('cắt đúng số trang; không chứa text của các trang bị cắt; trang giữ lại vẫn có text', async () => {
    const original = await makeMarkedPdf(10);
    const { bytes, totalPages, previewPages } = await buildPreviewPdf(original, 2);
    expect(totalPages).toBe(10);
    expect(previewPages).toBe(2);
    await expect(countPdfPages(bytes)).resolves.toBe(2);

    const text = await extractAllText(bytes);
    // Trang được giữ: marker phải xuất hiện (chứng tỏ việc trích text hoạt động thật).
    expect(text).toContain('PAGE-MARKER-1');
    expect(text).toContain('PAGE-MARKER-2');
    // Trang bị cắt: tuyệt đối không được xuất hiện.
    for (let i = 3; i <= 10; i++) {
      expect(text).not.toContain(`PAGE-MARKER-${i}`);
    }
    // Kể cả ở dạng bytes thô (chưa giải nén) cũng không được lộ marker bị cắt.
    const rawLatin1 = Buffer.from(bytes).toString('latin1');
    for (let i = 3; i <= 10; i++) {
      expect(rawLatin1).not.toContain(`PAGE-MARKER-${i}`);
    }
  });

  it('không mang theo metadata/outline/attachment của bản gốc', async () => {
    const original = await makeMarkedPdf(5);
    const { bytes } = await buildPreviewPdf(original, 1);
    const preview = await PDFDocument.load(bytes);
    expect(preview.getTitle() ?? '').toBe('');
    expect(preview.getAuthor() ?? '').toBe('');
    const catalog = preview.catalog;
    // Document mới không có Outlines / Names (nơi chứa attachment).
    expect(catalog.get(PDFName.of('Outlines'))).toBeUndefined();
    expect(catalog.get(PDFName.of('Names'))).toBeUndefined();
    expect(catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    // Info dict của bản gốc không bị copy sang.
    const rawLatin1 = Buffer.from(bytes).toString('latin1');
    expect(rawLatin1).not.toContain('Tieu de bi mat');
    expect(rawLatin1).not.toContain('Tac gia bi mat');
  });

  it('số trang xem trước không hợp lệ -> ném lỗi', async () => {
    const original = await makeMarkedPdf(3);
    await expect(buildPreviewPdf(original, 0)).rejects.toThrow();
    await expect(buildPreviewPdf(original, 3)).rejects.toThrow();
    await expect(buildPreviewPdf(original, 5)).rejects.toThrow();
  });

  it('PDF hỏng -> ném lỗi (job sẽ đánh failed)', async () => {
    await expect(countPdfPages(Buffer.from('khong phai pdf'))).rejects.toThrow();
    await expect(buildPreviewPdf(Buffer.from('%PDF-1.4 rac'), 1)).rejects.toThrow();
  });
});
