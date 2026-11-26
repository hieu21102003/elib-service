import { open } from 'node:fs/promises';
import { fileTypeFromBuffer } from 'file-type';
import { badRequest } from '../errors.js';

/**
 * Kiểm tra định dạng THẬT của file bằng nội dung (magic bytes), kết hợp đuôi file.
 * Whitelist Giai đoạn 1: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG/PNG/WEBP, TXT, DWG.
 *
 * Quy tắc đặc biệt (theo xác nhận của người dùng):
 * - .doc/.xls/.ppt đời cũ dùng chung magic OLE (D0 CF 11 E0) -> phân biệt bằng đuôi file;
 *   magic OLE với đuôi khác (vd .exe) bị từ chối.
 * - .docx/.xlsx/.pptx là ZIP (PK) -> magic ZIP + đuôi phải khớp; nếu quét được
 *   tên entry trong ZIP thì entry phải thuộc đúng họ (word/ cho docx, xl/ cho xlsx,
 *   ppt/ cho pptx), lệch họ bị từ chối.
 * - .txt không có magic -> kiểm tra toàn bộ nội dung là UTF-8 hợp lệ (strict),
 *   không chứa byte NUL / quá nhiều ký tự điều khiển.
 * - .dwg bắt đầu bằng chuỗi phiên bản "AC10xx" (vd AC1015, AC1027, AC1032).
 */

export type DetectedKind =
  | 'pdf' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'
  | 'jpg' | 'png' | 'webp' | 'txt' | 'dwg';

export interface DetectedFileType {
  kind: DetectedKind;
  extension: string; // đuôi chuẩn để lưu file (không dấu chấm)
  mimeType: string;
}

const MIME: Record<DetectedKind, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  dwg: 'application/acad'
};

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const HEADER_BYTES = 8192;

function startsWith(buf: Buffer, magic: Buffer): boolean {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}
function isJpg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
function isPng(buf: Buffer): boolean {
  return startsWith(buf, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
function isWebp(buf: Buffer): boolean {
  return buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP';
}
function isDwg(buf: Buffer): boolean {
  // Header DWG: 6 ký tự ASCII dạng AC10xx (AC1009..AC1032).
  if (buf.length < 6) return false;
  const head = buf.subarray(0, 6).toString('latin1');
  return /^AC10\d\d$/.test(head);
}

/** Quét tên entry trong phần đầu của ZIP (local file headers). Trả về danh sách tên thấy được. */
export function scanZipEntryNames(buf: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length) {
    // Local file header signature PK\x03\x04
    if (!(buf[offset] === 0x50 && buf[offset + 1] === 0x4b && buf[offset + 2] === 0x03 && buf[offset + 3] === 0x04)) {
      break;
    }
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) break;
    names.push(buf.subarray(nameStart, nameEnd).toString('utf8'));
    // Nếu compressedSize = 0 (data descriptor), không nhảy tin cậy được -> dừng quét.
    if (compressedSize === 0) break;
    offset = nameEnd + extraLen + compressedSize;
  }
  return names;
}

function zipFamily(names: string[]): 'word' | 'xl' | 'ppt' | null {
  if (names.some((n) => n.startsWith('word/'))) return 'word';
  if (names.some((n) => n.startsWith('xl/'))) return 'xl';
  if (names.some((n) => n.startsWith('ppt/'))) return 'ppt';
  return null;
}

/** Kiểm tra một Buffer có phải UTF-8 hợp lệ (strict) và là text thuần không. */
export function isValidUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    // Cho phép \t \n \r; các ký tự điều khiển khác quá nhiều -> coi là binary.
    let controls = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') controls++;
    }
    return text.length === 0 || controls / text.length < 0.01;
  } catch {
    return false;
  }
}

function mismatch(declaredExt: string): never {
  throw badRequest(
    'FILE_TYPE_MISMATCH',
    `Nội dung file không khớp với đuôi ".${declaredExt}". Vui lòng kiểm tra lại file.`
  );
}
function unsupported(): never {
  throw badRequest(
    'UNSUPPORTED_FILE_TYPE',
    'Định dạng file không được hỗ trợ. Chỉ chấp nhận: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG/PNG/WEBP, TXT, DWG.'
  );
}

/**
 * Xác định loại file từ header bytes + đuôi file khai báo.
 * Dùng cho unit test (truyền Buffer) — bản dùng trên đĩa là detectFileTypeFromPath.
 */
export async function detectFileType(header: Buffer, declaredExtension: string): Promise<DetectedFileType> {
  const ext = declaredExtension.toLowerCase().replace(/^\./, '');

  if (isPdf(header)) {
    if (ext !== 'pdf') mismatch(ext || '(không có đuôi)');
    return { kind: 'pdf', extension: 'pdf', mimeType: MIME.pdf };
  }
  if (isJpg(header)) {
    if (ext !== 'jpg' && ext !== 'jpeg') mismatch(ext || '(không có đuôi)');
    return { kind: 'jpg', extension: 'jpg', mimeType: MIME.jpg };
  }
  if (isPng(header)) {
    if (ext !== 'png') mismatch(ext || '(không có đuôi)');
    return { kind: 'png', extension: 'png', mimeType: MIME.png };
  }
  if (isWebp(header)) {
    if (ext !== 'webp') mismatch(ext || '(không có đuôi)');
    return { kind: 'webp', extension: 'webp', mimeType: MIME.webp };
  }
  if (startsWith(header, OLE_MAGIC)) {
    // OLE dùng chung cho .doc/.xls/.ppt -> phân biệt bằng đuôi file.
    if (ext === 'doc') return { kind: 'doc', extension: 'doc', mimeType: MIME.doc };
    if (ext === 'xls') return { kind: 'xls', extension: 'xls', mimeType: MIME.xls };
    if (ext === 'ppt') return { kind: 'ppt', extension: 'ppt', mimeType: MIME.ppt };
    return mismatch(ext || '(không có đuôi)');
  }
  if (startsWith(header, ZIP_MAGIC)) {
    const expectedFamily = ext === 'docx' ? 'word' : ext === 'xlsx' ? 'xl' : ext === 'pptx' ? 'ppt' : null;
    if (!expectedFamily) return mismatch(ext || '(không có đuôi)');
    const family = zipFamily(scanZipEntryNames(header));
    // Chỉ từ chối khi quét được entry và entry thuộc họ khác.
    if (family && family !== expectedFamily) return mismatch(ext);
    const kind = ext as DetectedKind;
    return { kind, extension: ext, mimeType: MIME[kind] };
  }
  if (isDwg(header)) {
    if (ext !== 'dwg') mismatch(ext || '(không có đuôi)');
    return { kind: 'dwg', extension: 'dwg', mimeType: MIME.dwg };
  }

  // TXT: không có magic — kiểm tra UTF-8 trên header (bản đầy đủ kiểm tra cả file ở detectFileTypeFromPath).
  if (ext === 'txt') {
    if (!isValidUtf8Text(header)) {
      throw badRequest('INVALID_TEXT_FILE', 'File .txt phải là văn bản UTF-8 hợp lệ.');
    }
    return { kind: 'txt', extension: 'txt', mimeType: MIME.txt };
  }

  // Lớp dự phòng: thư viện file-type (chỉ để bắt các trường hợp còn lại, vẫn phải khớp whitelist).
  const ft = await fileTypeFromBuffer(header).catch(() => undefined);
  if (ft) {
    // file-type nhận diện được nhưng không thuộc whitelist của ta (vd exe, zip thường) -> từ chối.
    return unsupported();
  }
  return unsupported();
}

/** Kiểm tra UTF-8 strict cho toàn bộ file trên đĩa, theo từng chunk (không nạp hết vào RAM). */
export async function validateUtf8File(absolutePath: string): Promise<boolean> {
  const { createReadStream } = await import('node:fs');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let controls = 0;
  let total = 0;
  try {
    for await (const chunk of createReadStream(absolutePath)) {
      const buf = chunk as Buffer;
      if (buf.includes(0)) return false;
      const text = decoder.decode(buf, { stream: true });
      total += text.length;
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') controls++;
      }
    }
    decoder.decode(); // flush: lỗi nếu còn byte dở dang
  } catch {
    return false;
  }
  return total === 0 || controls / total < 0.01;
}

/** Đọc header từ file trên đĩa rồi xác định loại; riêng TXT kiểm tra UTF-8 toàn file. */
export async function detectFileTypeFromPath(absolutePath: string, declaredExtension: string): Promise<DetectedFileType> {
  const handle = await open(absolutePath, 'r');
  let header: Buffer;
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    header = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const detected = await detectFileType(header, declaredExtension);
  if (detected.kind === 'txt') {
    const ok = await validateUtf8File(absolutePath);
    if (!ok) {
      throw badRequest('INVALID_TEXT_FILE', 'File .txt phải là văn bản UTF-8 hợp lệ.');
    }
  }
  return detected;
}

export function assertSizeWithinLimit(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes <= 0) {
    throw badRequest('EMPTY_FILE', 'File rỗng, vui lòng chọn file khác.');
  }
  if (sizeBytes > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw badRequest('FILE_TOO_LARGE', `File vượt quá dung lượng tối đa ${mb} MB.`);
  }
}
