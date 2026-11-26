const SPECIAL_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const ZERO_WIDTH_RE = /[\u00AD\u200B-\u200D\uFEFF\u2060]/g;
const SPECIAL_SPACES_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const LIGATURES: ReadonlyArray<[RegExp, string]> = [
  [/\uFB00/g, 'ff'],
  [/\uFB01/g, 'fi'],
  [/\uFB02/g, 'fl'],
  [/\uFB03/g, 'ffi'],
  [/\uFB04/g, 'ffl'],
  [/\uFB05/g, 'ft'],
  [/\uFB06/g, 'st'],
];

/**
 * Chuẩn hóa Unicode trước khi so khớp regex hay so sánh chuỗi:
 * - NFC
 * - Đưa U+2011 và các dấu gạch nối Unicode lạ về '-'
 * - Loại ký tự zero-width, control chars, chuẩn hóa khoảng trắng & ligature
 */
export function normalizeUnicode(raw: string): string {
  if (!raw) return '';
  let text = raw.normalize('NFC');
  for (const [re, rep] of LIGATURES) {
    text = text.replace(re, rep);
  }
  text = text
    .replace(ZERO_WIDTH_RE, '')
    .replace(SPECIAL_HYPHENS_RE, '-')
    .replace(SPECIAL_SPACES_RE, ' ')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

const TECHNICAL_DIGIT_SUFFIX_WHITELIST = new Set([
  'ipv4',
  'ipv6',
  'http2',
  'http3',
  'utf8',
  'utf16',
  'utf32',
  'sha1',
  'sha2',
  'sha256',
  'sha384',
  'sha512',
  'md5',
  'aes128',
  'aes256',
  'tls1',
  'tls12',
  'tls13',
  'h264',
  'h265',
  'mp3',
  'mp4',
  'part1',
  'part2',
  'part3',
  'level1',
  'level2',
  'level3',
  'phase1',
  'phase2',
  'type1',
  'type2',
  'tier1',
  'tier2',
  'rev1',
  'rev2',
  'rev3',
  'rev4',
  'rev5',
  'draft1',
  'draft2',
  'layer1',
  'layer2',
  'layer3',
  'iso1',
  'iso2',
  'cat1',
  'cat2',
  'class1',
  'class2',
  'class3',
  'a1',
  'a2',
  'b1',
  'b2',
  'c1',
  'c2',
  'v1',
  'v2',
  'v3',
  'v4',
]);

const VIETNAMESE_DIACRITIC_CHAR_RE =
  /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừữựỳỵỷỹàáâãèéêìíòóôõùúýĂĐƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỮỰỲỴỶỸÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝ]/;

/**
 * Fallback mức text để bỏ chỉ số trên chú thích dính sát cuối tiêu đề
 * (vd "ĐIỀU KHOẢN THI HÀNH9" -> "ĐIỀU KHOẢN THI HÀNH",
 *  "ĐƯỜNG SẮT ĐỊA PHƯƠNG6" -> "ĐƯỜNG SẮT ĐỊA PHƯƠNG")
 * mà vẫn bảo vệ mã kỹ thuật như IPv4, SHA256, Annex A1, EN 301 549.
 */
export function stripTrailingFootnoteMarker(rawTitle: string): {
  text: string;
  stripped: boolean;
} {
  const title = normalizeUnicode(rawTitle);
  // Trường hợp có dấu chấm/ngắt rồi tới số chú thích: "Điều 5. Quy định chung9" hoặc "Điều 5.1" không cắt nhầm
  const match = /^(.+?[\s\p{L}])([\p{L}]{3,})(\d{1,2})([)"”’]*)$/u.exec(title);
  if (!match) {
    // Xét trường hợp toàn bộ tiêu đề chỉ là 1 từ dài
    const singleWord = /^([\p{L}]{4,})(\d{1,2})([)"”’]*)$/u.exec(title);
    if (!singleWord) {
      return { text: title, stripped: false };
    }
    const word = singleWord[1];
    const digits = singleWord[2];
    const tailPunct = singleWord[3] ?? '';
    const fullLower = `${word}${digits}`.toLowerCase();
    if (TECHNICAL_DIGIT_SUFFIX_WHITELIST.has(fullLower)) {
      return { text: title, stripped: false };
    }
    if (VIETNAMESE_DIACRITIC_CHAR_RE.test(word) || word === word.toUpperCase()) {
      return { text: `${word}${tailPunct}`.trim(), stripped: true };
    }
    return { text: title, stripped: false };
  }

  const [, prefix, lastWord, digits, tailPunct] = match;
  const combinedWordLower = `${lastWord}${digits}`.toLowerCase();
  if (TECHNICAL_DIGIT_SUFFIX_WHITELIST.has(combinedWordLower)) {
    return { text: title, stripped: false };
  }
  // Nếu prefix trước đó kết thúc bằng dấu gạch nối hoặc số hiệu tiêu chuẩn liền kề (vd RFC9293, ISO9001, A-1) -> không cắt
  if (/[-/_]$/.test(prefix.trimEnd())) {
    return { text: title, stripped: false };
  }

  const isAllUpperWord = lastWord.length >= 4 && lastWord === lastWord.toUpperCase() && lastWord !== lastWord.toLowerCase();
  const hasViDiacritic = VIETNAMESE_DIACRITIC_CHAR_RE.test(lastWord) || VIETNAMESE_DIACRITIC_CHAR_RE.test(prefix);
  const isTrailingFootnoteDigit = Number.parseInt(digits, 10) >= 1 && Number.parseInt(digits, 10) <= 99;

  if (isTrailingFootnoteDigit && (hasViDiacritic || isAllUpperWord || lastWord.length >= 5)) {
    // Tránh cắt số phiên bản/revision kiểu "Version 2" hoặc "Rev 5" (những trường hợp có dấu cách đã không match regex này).
    // Tránh cắt các mã viết hoa ngắn 3 ký tự kiểu "ISO1" hoặc "IEC2"
    if (lastWord.length <= 3 && !hasViDiacritic) {
      return { text: title, stripped: false };
    }
    // Tránh cắt dạng "Annex A1", "Part1" đã có whitelist; kiểm tra thêm nếu chữ cuối viết hoa thuần ASCII <= 4 ký tự như "TYPE1"
    if (!hasViDiacritic && lastWord.length <= 4 && lastWord === lastWord.toUpperCase()) {
      return { text: title, stripped: false };
    }
    return {
      text: `${prefix}${lastWord}${tailPunct ?? ''}`.replace(/\s+/g, ' ').trim(),
      stripped: true,
    };
  }

  return { text: title, stripped: false };
}

export function stripVietnameseDiacritics(text: string): string {
  return text
    .replace(/[đĐ]/g, (ch) => (ch === 'đ' ? 'd' : 'D'))
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

const MAX_NORMALIZE_CACHE_SIZE = 25_000;
const comparisonKeyCache = new Map<string, string>();
const tokenSetCache = new Map<string, ReadonlySet<string>>();

export function toComparisonKey(text: string): string {
  const cached = comparisonKeyCache.get(text);
  if (cached !== undefined) return cached;
  const norm = normalizeUnicode(text);
  const key = stripVietnameseDiacritics(norm)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (comparisonKeyCache.size >= MAX_NORMALIZE_CACHE_SIZE) {
    comparisonKeyCache.clear();
  }
  comparisonKeyCache.set(text, key);
  return key;
}

export function getComparisonTokens(text: string): ReadonlySet<string> {
  const key = toComparisonKey(text);
  const cached = tokenSetCache.get(key);
  if (cached !== undefined) return cached;
  const set = new Set(
    key ? key.split(' ').filter((t) => t.length >= 2 || /^\d+$/.test(t)) : []
  );
  if (tokenSetCache.size >= MAX_NORMALIZE_CACHE_SIZE) {
    tokenSetCache.clear();
  }
  tokenSetCache.set(key, set);
  return set;
}

const JUNK_TITLES = new Set([
  'undefined',
  'null',
  'nan',
  'none',
  'untitled',
  'bookmark',
  'document',
  'section',
  'page',
]);

export function isJunkTitle(rawTitle: string): boolean {
  const norm = normalizeUnicode(rawTitle);
  if (!norm) return true;
  if (!/[\p{L}\p{N}]/u.test(norm)) return true;
  const lower = norm.toLowerCase();
  if (JUNK_TITLES.has(lower)) return true;
  if (/^[\s._\-–—•·]+$/.test(norm)) return true;
  return false;
}

export function isVirtualFirstPageTitle(rawTitle: string): boolean {
  const key = toComparisonKey(rawTitle);
  return (
    key === 'trang dau' ||
    key === 'first page' ||
    key === 'cover' ||
    key === 'title page' ||
    key === 'bia'
  );
}

export function isTableOrFigureCaption(rawTitle: string): boolean {
  const norm = normalizeUnicode(rawTitle);
  // Bắt cả dạng đánh số thường (Table 1, Figure 2.1, Bảng 3) lẫn đánh số theo Phụ lục (Table A.1, Figure B.2, Bảng C-1)
  return /^(?:Bảng|Hình|Biểu(?:\s+đồ)?|Sơ\s+đồ|Đồ\s+thị|Table|Figure|Fig\.?|Chart|Box|Listing|Diagram|Plate)\s+(?:[A-Z]{1,2}[.-]?\d+|\d+)(?:\.\d+)*(?:[.:)\-\s–—]|$)/i.test(
    norm
  );
}

export function cleanTocTitle(rawTitle: string): { title: string; strippedFootnote: boolean } {
  const norm = normalizeUnicode(rawTitle);
  const { text, stripped } = stripTrailingFootnoteMarker(norm);
  return {
    title: text.replace(/\s+[.·…]{2,}\s*$/, '').trim(),
    strippedFootnote: stripped,
  };
}

export function clampConfidence(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 100) / 100;
}

export function tokenOverlapScore(a: string, b: string): number {
  const ka = toComparisonKey(a);
  const kb = toComparisonKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.includes(kb) || kb.includes(ka)) {
    const shorter = Math.min(ka.length, kb.length);
    const longer = Math.max(ka.length, kb.length);
    if (shorter >= 6) return Math.max(0.75, shorter / longer);
  }
  const tokensA = getComparisonTokens(a);
  const tokensB = getComparisonTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const [smaller, larger] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  let inter = 0;
  for (const t of smaller) {
    if (larger.has(t)) inter++;
  }
  return (2 * inter) / (tokensA.size + tokensB.size);
}
