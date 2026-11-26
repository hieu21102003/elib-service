import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { QpdfExecResult, QpdfRunner } from '../../src/previews/qpdf.js';

/**
 * Helper tạo PDF test mã hóa RC4-128 chuẩn ISO 32000-1 (V=2, R=3) thuần JS
 * (không phụ thuộc OpenSSL legacy provider trên Node 22+) và mock qpdf runner
 * thực hiện xác thực mật khẩu + giải mã RC4 thật từ bytes file trên đĩa.
 */

// 32-byte padding string chuẩn ISO 32000-1 Section 7.6.3.3.
const PDF_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

/** Mặc định giống EN_50126_1.pdf: cho xem/in thường, chặn sửa và chặn ghép trang. */
export const DEFAULT_RESTRICTED_PERMISSIONS = -3388;

function md5(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(data).digest());
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function padPassword(password: string): Uint8Array {
  const raw = Buffer.from(password, 'latin1');
  const out = new Uint8Array(32);
  const copyLen = Math.min(32, raw.length);
  out.set(raw.subarray(0, copyLen), 0);
  if (copyLen < 32) {
    out.set(PDF_PADDING.subarray(0, 32 - copyLen), copyLen);
  }
  return out;
}

function int32Le(value: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value, 0);
  return new Uint8Array(buf);
}

function computeOwnerO(ownerPassword: string, userPassword: string): Uint8Array {
  const paddedOwner = padPassword(ownerPassword || userPassword);
  let digest = md5(paddedOwner);
  for (let i = 0; i < 50; i++) {
    digest = md5(digest);
  }
  let enc = rc4(digest, padPassword(userPassword));
  const key = new Uint8Array(16);
  for (let x = 1; x <= 19; x++) {
    for (let i = 0; i < 16; i++) key[i] = digest[i] ^ x;
    enc = rc4(key, enc);
  }
  return enc;
}

function computeFileKeyR3(
  userPassword: string,
  oBytes: Uint8Array,
  permissions: number,
  id0: Uint8Array
): Uint8Array {
  let digest = md5(concatBytes(padPassword(userPassword), oBytes, int32Le(permissions), id0));
  for (let i = 0; i < 50; i++) {
    digest = md5(digest.subarray(0, 16));
  }
  return digest.subarray(0, 16);
}

function computeUserUR3(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  let enc = rc4(fileKey, md5(concatBytes(PDF_PADDING, id0)));
  const key = new Uint8Array(16);
  for (let x = 1; x <= 19; x++) {
    for (let i = 0; i < 16; i++) key[i] = fileKey[i] ^ x;
    enc = rc4(key, enc);
  }
  return concatBytes(enc, new Uint8Array(16));
}

function computeObjectKey(fileKey: Uint8Array, objNum: number, genNum = 0): Uint8Array {
  const suffix = Uint8Array.from([
    objNum & 0xff,
    (objNum >> 8) & 0xff,
    (objNum >> 16) & 0xff,
    genNum & 0xff,
    (genNum >> 8) & 0xff
  ]);
  return md5(concatBytes(fileKey, suffix)).subarray(0, 16);
}

function toHexString(bytes: Uint8Array): string {
  return `<${Buffer.from(bytes).toString('hex')}>`;
}

export interface TestPdfOptions {
  pageCount: number;
  title?: string;
  author?: string;
  userPassword?: string;
  ownerPassword?: string;
  permissions?: number;
}

function buildPdfBytes(opts: TestPdfOptions, encrypted: boolean): Uint8Array {
  const {
    pageCount,
    title = 'Tieu de bi mat cua ban goc',
    author = 'Tac gia bi mat',
    userPassword = '',
    ownerPassword = 'owner-secret-password',
    permissions = DEFAULT_RESTRICTED_PERMISSIONS
  } = opts;

  const id0 = Uint8Array.from([
    0x45, 0x4c, 0x49, 0x42, 0x35, 0x30, 0x31, 0x32,
    0x36, 0x5f, 0x31, 0x5f, 0x54, 0x45, 0x53, 0x54
  ]);

  let fileKey: Uint8Array | null = null;
  let oBytes: Uint8Array | null = null;
  let uBytes: Uint8Array | null = null;
  if (encrypted) {
    oBytes = computeOwnerO(ownerPassword, userPassword);
    fileKey = computeFileKeyR3(userPassword, oBytes, permissions, id0);
    uBytes = computeUserUR3(fileKey, id0);
  }

  const encString = (objNum: number, text: string): string => {
    const raw = Buffer.from(text, 'latin1');
    if (!fileKey) return toHexString(raw);
    return toHexString(rc4(computeObjectKey(fileKey, objNum), raw));
  };

  const encBytes = (objNum: number, raw: Uint8Array): Uint8Array => {
    if (!fileKey) return raw;
    return rc4(computeObjectKey(fileKey, objNum), raw);
  };

  // Bố trí số hiệu object cố định:
  // 1: Catalog, 2: Pages, 3: Outlines, 4: Outline item,
  // 5: Names, 6: Filespec, 7: EmbeddedFile stream,
  // 8: Info, 9: Font, (10: Encrypt nếu mã hóa),
  // Sau đó mỗi trang gồm 2 object: Page và Content stream.
  const firstPageObj = encrypted ? 11 : 10;
  const pageRefs: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    pageRefs.push(`${firstPageObj + i * 2} 0 R`);
  }

  const objects: Array<{ num: number; body: Uint8Array }> = [];
  const addTextObj = (num: number, content: string) => {
    objects.push({ num, body: Buffer.from(`${num} 0 obj\n${content}\nendobj\n`, 'latin1') });
  };
  const addStreamObj = (num: number, dictEntries: string, rawStream: Uint8Array) => {
    const data = encBytes(num, rawStream);
    const head = Buffer.from(
      `${num} 0 obj\n<< ${dictEntries} /Length ${data.length} >>\nstream\n`,
      'latin1'
    );
    const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
    objects.push({ num, body: concatBytes(head, data, tail) });
  };

  addTextObj(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R /Names 5 0 R >>');
  addTextObj(2, `<< /Type /Pages /Kids [ ${pageRefs.join(' ')} ] /Count ${pageCount} >>`);
  addTextObj(3, '<< /Type /Outlines /First 4 0 R /Last 4 0 R /Count 1 >>');
  addTextObj(
    4,
    `<< /Title ${encString(4, 'Muc luc bi mat')} /Parent 3 0 R /Dest [ ${firstPageObj} 0 R /Fit ] >>`
  );
  addTextObj(5, `<< /EmbeddedFiles << /Names [ ${encString(5, 'secret-attachment.txt')} 6 0 R ] >> >>`);
  addTextObj(
    6,
    `<< /Type /Filespec /F ${encString(6, 'secret-attachment.txt')} /EF << /F 7 0 R >> >>`
  );
  addStreamObj(7, '/Type /EmbeddedFile', Buffer.from('SECRET-ATTACHMENT-BODY', 'latin1'));
  addTextObj(8, `<< /Title ${encString(8, title)} /Author ${encString(8, author)} >>`);
  addTextObj(9, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  if (encrypted && oBytes && uBytes) {
    addTextObj(
      10,
      `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${permissions} /O ${toHexString(oBytes)} /U ${toHexString(uBytes)} >>`
    );
  }

  for (let i = 0; i < pageCount; i++) {
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;
    addTextObj(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 400 ] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    const contentText = `BT\n/F1 14 Tf\n50 300 Td\n(PAGE-MARKER-${i + 1}) Tj\nET\n`;
    addStreamObj(contentNum, '', Buffer.from(contentText, 'latin1'));
  }

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks: Uint8Array[] = [header];
  const offsets = new Map<number, number>();
  let cursor = header.length;
  for (const obj of objects) {
    offsets.set(obj.num, cursor);
    chunks.push(obj.body);
    cursor += obj.body.length;
  }

  const totalObjs = objects.length + 1;
  const xrefOffset = cursor;
  const xrefLines = [`xref\n0 ${totalObjs}\n`, '0000000000 65535 f \n'];
  for (let num = 1; num < totalObjs; num++) {
    const off = offsets.get(num) ?? 0;
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  const idHex = Buffer.from(id0).toString('hex');
  const encryptRef = encrypted ? ' /Encrypt 10 0 R' : '';
  const trailer =
    `trailer\n<< /Size ${totalObjs} /Root 1 0 R /Info 8 0 R${encryptRef} /ID [<${idHex}><${idHex}>] >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xrefLines.join('') + trailer, 'latin1'));
  return concatBytes(...chunks);
}

/** Tạo PDF chuẩn không mã hóa (dùng làm đối chứng cho cấu trúc PDF của helper). */
export function makePlainMinimalPdf(opts: TestPdfOptions): Uint8Array {
  return buildPdfBytes(opts, false);
}

/** Tạo PDF mã hóa RC4-128 (V=2, R=3) có `/Info`, `/Outlines`, `/Names` (attachment). */
export function makeRc4EncryptedPdf(opts: TestPdfOptions): Uint8Array {
  return buildPdfBytes(opts, true);
}

interface ParsedEncryptedPdf {
  pageCount: number;
  permissions: number;
  oBytes: Uint8Array;
  uBytes: Uint8Array;
  id0: Uint8Array;
  pageMarkers: string[];
}

function parseHexField(raw: string, pattern: RegExp): Uint8Array {
  const m = raw.match(pattern);
  if (!m) throw new Error(`Không đọc được trường mã hóa khớp ${pattern}`);
  return new Uint8Array(Buffer.from(m[1], 'hex'));
}

function parseRc4PdfForMock(buf: Buffer): ParsedEncryptedPdf {
  const raw = buf.toString('latin1');
  const countMatch = raw.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
  if (!countMatch) throw new Error('Không đọc được /Count từ PDF');
  const pageCount = Number.parseInt(countMatch[1], 10);
  const pMatch = raw.match(/\/P\s+(-?\d+)/);
  if (!pMatch) throw new Error('Không đọc được /P từ /Encrypt');
  const permissions = Number.parseInt(pMatch[1], 10);
  const oBytes = parseHexField(raw, /\/O\s*<([0-9a-fA-F]{64})>/);
  const uBytes = parseHexField(raw, /\/U\s*<([0-9a-fA-F]{64})>/);
  const id0 = parseHexField(raw, /\/ID\s*\[\s*<([0-9a-fA-F]{32})>/);

  // Giải mã từng content stream theo object number thực trong file.
  const pageMarkers: string[] = [];
  const objRe = /(\d+)\s+0\s+obj\s*<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw)) !== null) {
    const objNum = Number.parseInt(m[1], 10);
    const dict = m[2];
    if (dict.includes('/EmbeddedFile')) continue;
    const streamBytes = Buffer.from(m[3], 'latin1');
    pageMarkers.push(`${objNum}:${streamBytes.toString('hex')}`);
  }
  return { pageCount, permissions, oBytes, uBytes, id0, pageMarkers };
}

function decryptStreamRecords(parsed: ParsedEncryptedPdf, fileKey: Uint8Array): string[] {
  const texts: string[] = [];
  for (const record of parsed.pageMarkers) {
    const sep = record.indexOf(':');
    const objNum = Number.parseInt(record.slice(0, sep), 10);
    const cipher = new Uint8Array(Buffer.from(record.slice(sep + 1), 'hex'));
    const plain = Buffer.from(rc4(computeObjectKey(fileKey, objNum), cipher)).toString('latin1');
    const textMatch = plain.match(/\(([^)]+)\)\s*Tj/);
    if (textMatch) texts.push(textMatch[1]);
  }
  return texts;
}

export interface MockQpdfCall {
  bin: string;
  args: string[];
  timeoutMs: number;
}

export interface MockQpdfOptions {
  /** Gán exitCode khi thành công (vd 3 để giả lập warning không nghiêm trọng của qpdf). */
  successExitCode?: number;
}

/**
 * Tạo runner mô phỏng `qpdf` đọc file thật từ đĩa, kiểm tra mật khẩu bằng đúng
 * Algorithm 2 & 5 của PDF RC4-128 và giải mã content stream để ghi file PDF mới.
 */
export function createMockQpdfRunner(opts: MockQpdfOptions = {}) {
  const calls: MockQpdfCall[] = [];
  const successCode = opts.successExitCode ?? 0;

  const runner: QpdfRunner = async (bin, args, timeoutMs): Promise<QpdfExecResult> => {
    calls.push({ bin, args: [...args], timeoutMs });

    // Mode 1: ["--password=<pw>", "--show-npages", "<in>"]
    if (args.length === 3 && args[0].startsWith('--password=') && args[1] === '--show-npages') {
      const password = args[0].slice('--password='.length);
      const inputPath = args[2];
      const buf = await readFile(inputPath);
      const parsed = parseRc4PdfForMock(buf);
      const key = computeFileKeyR3(password, parsed.oBytes, parsed.permissions, parsed.id0);
      const expectedU = computeUserUR3(key, parsed.id0).subarray(0, 16);
      if (!Buffer.from(expectedU).equals(Buffer.from(parsed.uBytes.subarray(0, 16)))) {
        return {
          exitCode: 2,
          signal: null,
          stdout: '',
          stderr: `qpdf: ${inputPath}: invalid password\n`
        };
      }
      return {
        exitCode: successCode,
        signal: null,
        stdout: `${parsed.pageCount}\n`,
        stderr: successCode === 3 ? 'WARNING: simulated qpdf non-fatal warning\n' : ''
      };
    }

    // Mode 2: ["--empty", "--pages", "<in>", "--password=<pw>", "1-N", "--", "<out>"]
    if (
      args.length === 7 &&
      args[0] === '--empty' &&
      args[1] === '--pages' &&
      args[3].startsWith('--password=') &&
      args[5] === '--'
    ) {
      const inputPath = args[2];
      const password = args[3].slice('--password='.length);
      const range = args[4];
      const outputPath = args[6];
      const rangeMatch = range.match(/^1-(\d+)$/);
      if (!rangeMatch) {
        return { exitCode: 2, signal: null, stdout: '', stderr: `invalid page range ${range}` };
      }
      const endPage = Number.parseInt(rangeMatch[1], 10);

      const buf = await readFile(inputPath);
      const parsed = parseRc4PdfForMock(buf);
      const key = computeFileKeyR3(password, parsed.oBytes, parsed.permissions, parsed.id0);
      const expectedU = computeUserUR3(key, parsed.id0).subarray(0, 16);
      if (!Buffer.from(expectedU).equals(Buffer.from(parsed.uBytes.subarray(0, 16)))) {
        return {
          exitCode: 2,
          signal: null,
          stdout: '',
          stderr: `qpdf: ${inputPath}: invalid password\n`
        };
      }

      const decodedMarkers = decryptStreamRecords(parsed, key);
      const outDoc = await PDFDocument.create();
      const font = await outDoc.embedFont(StandardFonts.Helvetica);
      for (let i = 0; i < endPage; i++) {
        const page = outDoc.addPage([300, 400]);
        page.drawText(decodedMarkers[i] ?? `PAGE-${i + 1}`, { x: 50, y: 300, size: 14, font });
      }
      outDoc.setTitle('');
      outDoc.setAuthor('');
      outDoc.setSubject('');
      outDoc.setKeywords([]);
      outDoc.setProducer('');
      outDoc.setCreator('');
      await writeFile(outputPath, await outDoc.save());

      return {
        exitCode: successCode,
        signal: null,
        stdout: '',
        stderr: successCode === 3 ? 'WARNING: simulated qpdf non-fatal warning\n' : ''
      };
    }

    throw new Error(`Mock qpdf nhận bộ tham số không mong đợi: ${JSON.stringify(args)}`);
  };

  return { runner, calls };
}
