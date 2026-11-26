import { describe, it, expect } from 'vitest';
import { detectFileType, isValidUtf8Text, assertSizeWithinLimit } from '../src/files/validation.js';
import { sanitizeFilename } from '../src/files/filename.js';
import { sha256OfBuffer } from '../src/files/checksum.js';
import { slugify } from '../src/slug.js';

const PDF = Buffer.from('%PDF-1.7\n%fake-pdf-body');
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

/** Tạo một ZIP local-file-header tối thiểu với một entry cho trước (không nén thật). */
function fakeZip(entryName: string): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  const data = Buffer.from('x');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(data.length, 18); // compressed size
  header.writeUInt32LE(data.length, 22); // uncompressed size
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name, data]);
}

describe('detectFileType — magic bytes + đuôi file', () => {
  it('chấp nhận PDF thật với đuôi .pdf', async () => {
    const d = await detectFileType(PDF, 'pdf');
    expect(d.kind).toBe('pdf');
    expect(d.mimeType).toBe('application/pdf');
  });

  it('từ chối PDF bytes nhưng đặt tên .docx (không khớp)', async () => {
    await expect(detectFileType(PDF, 'docx')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' });
  });

  it('OLE + .doc/.xls/.ppt được chấp nhận và phân biệt bằng đuôi', async () => {
    expect((await detectFileType(OLE, 'doc')).kind).toBe('doc');
    expect((await detectFileType(OLE, 'xls')).kind).toBe('xls');
    expect((await detectFileType(OLE, 'ppt')).kind).toBe('ppt');
  });

  it('OLE + đuôi lạ (.exe) bị từ chối', async () => {
    await expect(detectFileType(OLE, 'exe')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' });
  });

  it('ZIP chứa word/ + .docx được chấp nhận; ZIP chứa xl/ + .docx bị từ chối', async () => {
    expect((await detectFileType(fakeZip('word/document.xml'), 'docx')).kind).toBe('docx');
    expect((await detectFileType(fakeZip('xl/workbook.xml'), 'xlsx')).kind).toBe('xlsx');
    expect((await detectFileType(fakeZip('ppt/presentation.xml'), 'pptx')).kind).toBe('pptx');
    await expect(detectFileType(fakeZip('xl/workbook.xml'), 'docx')).rejects.toMatchObject({
      code: 'FILE_TYPE_MISMATCH'
    });
  });

  it('ảnh JPG/PNG/WEBP đúng magic được chấp nhận, sai đuôi bị từ chối', async () => {
    expect((await detectFileType(JPG, 'jpg')).kind).toBe('jpg');
    expect((await detectFileType(JPG, 'jpeg')).extension).toBe('jpg');
    expect((await detectFileType(PNG, 'png')).kind).toBe('png');
    expect((await detectFileType(WEBP, 'webp')).kind).toBe('webp');
    await expect(detectFileType(PNG, 'jpg')).rejects.toMatchObject({ code: 'FILE_TYPE_MISMATCH' });
  });

  it('TXT UTF-8 hợp lệ (kể cả tiếng Việt) được chấp nhận', async () => {
    const txt = Buffer.from('Tài liệu đường sắt — khổ 1435 mm\nDòng hai.', 'utf8');
    expect((await detectFileType(txt, 'txt')).kind).toBe('txt');
    expect(isValidUtf8Text(txt)).toBe(true);
  });

  it('binary giả danh .txt bị từ chối', async () => {
    const binary = Buffer.from([0x00, 0x9f, 0x8f, 0xff, 0xfe, 0x01, 0x02]);
    await expect(detectFileType(binary, 'txt')).rejects.toMatchObject({ code: 'INVALID_TEXT_FILE' });
    expect(isValidUtf8Text(binary)).toBe(false);
  });

  it('DWG header AC10xx được chấp nhận, header ngẫu nhiên bị từ chối', async () => {
    const dwg = Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.alloc(64)]);
    expect((await detectFileType(dwg, 'dwg')).kind).toBe('dwg');
    const dwgOld = Buffer.concat([Buffer.from('AC1015', 'latin1'), Buffer.alloc(64)]);
    expect((await detectFileType(dwgOld, 'dwg')).kind).toBe('dwg');
    const random = Buffer.from('XXXXXX-not-a-dwg-file-content-here');
    await expect(detectFileType(random, 'dwg')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('file lạ ngoài whitelist bị từ chối', async () => {
    await expect(detectFileType(Buffer.from('MZ\x90\x00exe-header'), 'exe')).rejects.toBeTruthy();
  });
});

describe('giới hạn dung lượng', () => {
  it('file quá lớn bị từ chối, file rỗng bị từ chối', () => {
    expect(() => assertSizeWithinLimit(201 * 1024 * 1024, 200 * 1024 * 1024)).toThrowError(/dung lượng tối đa/);
    expect(() => assertSizeWithinLimit(0, 200 * 1024 * 1024)).toThrowError(/rỗng/);
    expect(() => assertSizeWithinLimit(1024, 200 * 1024 * 1024)).not.toThrow();
  });
});

describe('sanitizeFilename', () => {
  it('chặn path traversal', () => {
    expect(() => sanitizeFilename('../secret.pdf')).toThrowError(/đường dẫn/);
    expect(() => sanitizeFilename('..\\secret.pdf')).toThrowError(/đường dẫn/);
    expect(() => sanitizeFilename('a/b.pdf')).toThrowError(/đường dẫn/);
    expect(() => sanitizeFilename('..')).toThrowError(/không hợp lệ/);
  });

  it('giữ tên hiển thị an toàn và lấy đuôi viết thường', () => {
    const s = sanitizeFilename('Báo cáo Đường sắt.PDF');
    expect(s.displayName).toBe('Báo cáo Đường sắt.PDF');
    expect(s.extension).toBe('pdf');
    const dotted = sanitizeFilename('.hidden.pdf');
    expect(dotted.displayName).toBe('hidden.pdf');
  });
});

describe('SHA-256 + slug', () => {
  it('SHA-256 đúng vector đã biết ("abc")', () => {
    expect(sha256OfBuffer(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('slug bỏ dấu tiếng Việt', () => {
    expect(slugify('Công trình đường sắt tốc độ cao')).toBe('cong-trinh-duong-sat-toc-do-cao');
    expect(slugify('  TCVN 13592:2022 — Đường sắt  ')).toBe('tcvn-13592-2022-duong-sat');
    expect(slugify('')).toBe('tai-lieu');
  });
});
