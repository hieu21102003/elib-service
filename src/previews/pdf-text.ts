import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  decodePDFRawStream,
  type PDFObject,
  type PDFRef
} from 'pdf-lib';

/**
 * Trích chữ thô từ vài trang đầu của PDF bằng API cấp thấp của pdf-lib
 * (decodePDFRawStream + quét chuỗi trong content stream) — KHÔNG thêm
 * dependency mới. Chỉ phục vụ job kiểm tra mã chuẩn: đủ để tìm một mã
 * dạng "TCVN 14552-1:2025" in trên trang bìa/trang đầu.
 *
 * Giới hạn đã biết (chấp nhận được cho mục đích cảnh báo, không chặn):
 * - Chuỗi hex của font CID (glyph id) không map sang Unicode được nếu
 *   thiếu ToUnicode — phần đó cho ra ký tự rác, mã có thể bị báo
 *   not_found oan. Chuỗi literal (WinAnsi) và hex UTF-16BE (có BOM
 *   FEFF) được xử lý đúng.
 * - Chữ nằm trong Form XObject không được quét.
 */

function decodeLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    i++;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '(':
      case ')':
      case '\\':
        out += next;
        break;
      case '\n':
        break; // nối dòng: bỏ qua
      case '\r':
        if (raw[i + 1] === '\n') i++;
        break;
      default: {
        if (next >= '0' && next <= '7') {
          let octal = next;
          for (let k = 0; k < 2; k++) {
            const d = raw[i + 1];
            if (d !== undefined && d >= '0' && d <= '7') {
              octal += d;
              i++;
            } else break;
          }
          out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        } else {
          out += next;
        }
      }
    }
  }
  return out;
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE có BOM.
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  return bytes.toString('latin1');
}

/**
 * Quét mọi chuỗi literal `(...)` và hex `<...>` trong một content stream
 * đã giải nén, nối liền nhau (không chèn khoảng trắng) để mã bị tách
 * thành nhiều mảnh TJ vẫn ghép lại được.
 */
export function extractStringsFromContentStream(data: Uint8Array): string {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') {
      // Chuỗi literal: cân bằng ngoặc, tôn trọng escape.
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === '\\' && j + 1 < text.length) {
          raw += c + text[j + 1];
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        raw += c;
        j++;
      }
      parts.push(decodeLiteralString(raw));
      i = j + 1;
      continue;
    }
    if (ch === '<' && text[i + 1] !== '<') {
      const end = text.indexOf('>', i + 1);
      if (end === -1) break;
      const hex = text.slice(i + 1, end);
      if (/^[0-9a-fA-F\s]+$/.test(hex)) {
        parts.push(decodeHexString(hex));
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return parts.join('');
}

function contentStreamsOfPage(doc: PDFDocument, pageIndex: number): PDFRawStream[] {
  const page = doc.getPages()[pageIndex];
  if (!page) return [];
  const contents = page.node.Contents() as PDFObject | undefined;
  if (!contents) return [];
  const streams: PDFRawStream[] = [];
  const collect = (obj: PDFObject | undefined): void => {
    if (!obj) return;
    const looked = doc.context.lookup(obj as PDFRef);
    if (looked instanceof PDFRawStream) {
      streams.push(looked);
    } else if (looked instanceof PDFArray) {
      for (let k = 0; k < looked.size(); k++) {
        collect(looked.get(k));
      }
    }
  };
  collect(contents);
  return streams;
}

/**
 * Trích chữ thô từ tối đa `maxPages` trang đầu. Ném lỗi khi PDF hỏng/mã
 * hóa (caller quyết định fallback qpdf). Trang nào giải nén lỗi thì bỏ
 * qua trang đó thay vì hỏng cả file.
 */
export async function extractPdfTextFromFirstPages(
  bytes: Uint8Array,
  maxPages: number
): Promise<string> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const limit = Math.max(1, Math.min(maxPages, doc.getPageCount()));
  const chunks: string[] = [];
  for (let p = 0; p < limit; p++) {
    for (const stream of contentStreamsOfPage(doc, p)) {
      try {
        const decoded = decodePDFRawStream(stream).decode();
        chunks.push(extractStringsFromContentStream(decoded));
      } catch {
        // Filter không hỗ trợ / stream hỏng: bỏ qua stream này.
      }
    }
  }
  return chunks.join('');
}

/** Chuẩn hóa để so khớp mã: bỏ dấu tiếng Việt, uppercase, bỏ mọi khoảng trắng. */
export function normalizeForCodeSearch(text: string): string {
  return text
    .replace(/[đĐ]/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Kiểm tra một trong các dạng mã ứng viên có xuất hiện trong chữ đã trích
 * hay không (so trên bản đã chuẩn hóa bỏ khoảng trắng). Ứng viên rỗng bị
 * bỏ qua; không có ứng viên nào -> false.
 */
export function pdfTextContainsCode(text: string, candidates: Array<string | null | undefined>): boolean {
  const haystack = normalizeForCodeSearch(text);
  if (haystack.length === 0) return false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const needle = normalizeForCodeSearch(candidate);
    if (needle.length > 0 && haystack.includes(needle)) return true;
  }
  return false;
}
