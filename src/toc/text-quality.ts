import { normalizeUnicode } from './normalize.js';
import type { PageQualityAssessment } from './types.js';

const VIETNAMESE_SPECIFIC_DIACRITICS_RE =
  /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừữựỳỵỷỹĂĐƠƯẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỮỰỲỴỶỸ]/g;

// Ký tự bảng mã TCVN3 / VNI / Windows-1252 hay xuất hiện khi lỗi font hoặc OCR tiếng Việt hỏng
const MOJIBAKE_CHARS_RE = /[ß·µ¶¸¹»¼½¾¿®¬­ªºÆÇÐÑÖ×ØÞæçþ]/g;

// Ký tự lạ thực sự (trừ + - = < > * | thường dùng trong công thức toán hoặc sơ đồ ASCII RFC)
const HARD_GARBAGE_CHARS_RE = /[\uFFFD\uE000-\uF8FF\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F]/g;
const WEIRD_SYMBOL_CHARS_RE = /[~^`\\@#$%{}]/g;

// Các từ đặc trưng tiếng Việt KHÔNG phải từ tiếng Anh thông dụng
const STRIPPED_VIETNAMESE_MARKERS = new Set([
  'cua',
  'khong',
  'duoc',
  'nhung',
  'nguoi',
  'truong',
  'chuong',
  'dieu',
  'quoc',
  'chuan',
  'thiet',
  'trinh',
  'nghi',
  'quyet',
  'thong',
  'huong',
  'dinh',
  'phuong',
  'luong',
  'nuoc',
  'duong',
  'giao',
  'xay',
  'dung',
  'thuat',
  'nganh',
  'thanh',
  'huyen',
  'khoan',
  'kiem',
  'nghiem',
  'chinh',
  'quyen',
  'phap',
  'luat',
  'ngay',
  'thang',
  'hieu',
  'hanh',
  'toan',
  'tich',
  'khoi',
  'tiet',
  'pham',
  'loai',
  'muc',
  'bao',
  'dam',
  'moi',
  'sinh',
  'giay',
  'phep',
]);

// Ký tự viết hoa có dấu tiếng Việt/Latin nằm giữa từ chữ thường (vd "tiẾu", "ÐiÒu", "chuÈn")
const INTERNAL_UPPER_ACCENT_RE =
  /\p{Ll}[\p{Lu}]/u;

const VOWEL_RE =
  /[aeiouyAEIOUYàáâãèéêìíòóôõùúýÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝăđơưĂĐƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừữựỳỵỷỹẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼẾỀỂỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪỮỰỲỴỶỸ]/;

const EXCESSIVE_CONSONANTS_RE =
  /[bcdfghjklmnpqrstvwxzBCDFGHJKLMNPQRSTVWXZ]{6,}/;

const TOKEN_INTERNAL_CORRUPTION_RE =
  /(?:[a-zà-ỹ][~^`|\\!@#$%&*+=<>][a-zà-ỹ])|(?:[a-zà-ỹ]{2,}[0-9][a-zà-ỹ]{2,})/iu;

const VALID_ALNUM_MIX_RE =
  /^(?:sha\d+|utf\d+|ipv[46]|http\d+|tls\d+|aes\d+|base\d+|win\d+|mp[34]|h26[45]|3gpp|ieee\d+|iso\d+|tcvn\d+|qcvn\d+|rfc\d+|b2b|b2c|p2p|c2s|e2e|a11y|i18n|l10n|k8s|x\d+)$/i;

const COMBINING_STACK_RE = /\p{M}{3,}/gu;

/**
 * Đánh giá chất lượng chữ trên TỪNG TRANG (độc lập ngôn ngữ, hỗ trợ cả tiếng Anh và tiếng Việt).
 * Trang thuần ảnh hoặc trang OCR rác được gắn `needsOcr: true` để tách khỏi tập trang tin cậy.
 */
export function assessPageTextQuality(
  rawPageText: string,
  hasImageOps: boolean
): PageQualityAssessment {
  const rawNonSpace = rawPageText.replace(/\s+/g, '');
  if (rawNonSpace.length < 20) {
    if (hasImageOps) {
      return {
        quality: 'image_only',
        score: 0,
        needsOcr: true,
        reasons: ['no_text_layer_with_image'],
      };
    }
    return {
      quality: 'empty',
      score: 1,
      needsOcr: false,
      reasons: ['empty_or_minimal_page'],
    };
  }

  const reasons: string[] = [];
  const rawLen = rawNonSpace.length;

  const hardGarbageCount =
    (rawPageText.match(HARD_GARBAGE_CHARS_RE)?.length ?? 0) +
    (rawPageText.match(COMBINING_STACK_RE)?.length ?? 0) * 2;
  const hardGarbageRatio = hardGarbageCount / rawLen;

  const mojibakeCount = rawPageText.match(MOJIBAKE_CHARS_RE)?.length ?? 0;
  const mojibakeRatio = mojibakeCount / rawLen;

  const weirdCount = rawPageText.match(WEIRD_SYMBOL_CHARS_RE)?.length ?? 0;
  const weirdRatio = weirdCount / rawLen;

  // Loại trừ dòng banner tiêu đề in hoa giãn chữ (vd "T I Ê U C H U Ẩ N Q U Ố C G I A") khi đếm OCR tách chữ,
  // chỉ bỏ qua tối đa 2 dòng/trang để không bỏ sót trang OCR rác toàn chữ hoa.
  const textLines = rawPageText.split(/\r?\n/);
  let uppercaseBannerLines = 0;
  const nonBannerLines: string[] = [];
  for (const rawLine of textLines) {
    const ln = normalizeUnicode(rawLine);
    const toks = ln.split(/\s+/).filter((t) => /^\p{L}+$/u.test(t));
    const singleToks = toks.filter((t) => t.length === 1);
    const upperSingleToks = singleToks.filter((t) => t === t.toUpperCase() && t !== t.toLowerCase());
    const isDecorativeUpperBanner =
      uppercaseBannerLines < 2 &&
      singleToks.length >= 6 &&
      upperSingleToks.length / singleToks.length >= 0.85 &&
      !TOKEN_INTERNAL_CORRUPTION_RE.test(ln);
    if (isDecorativeUpperBanner) {
      uppercaseBannerLines++;
    } else {
      nonBannerLines.push(rawLine);
    }
  }
  const norm = normalizeUnicode(nonBannerLines.join('\n'));
  const letterMatches = norm.match(/\p{L}/gu) ?? [];
  const letterCount = letterMatches.length;

  const rawTokens = norm.split(/\s+/).filter(Boolean);
  const letterTokens = rawTokens.filter((t) => /\p{L}/u.test(t));

  let corruptedTokens = 0;
  let internalWeirdCaseTokens = 0;
  let pureWordCount = 0;
  let vowellessWords = 0;
  let singleCharRun = 0;
  let maxSingleCharRun = 0;
  let singleCharTokens = 0;

  // Đếm dấu câu đứng sai vị trí bên trong từ (vd "th.is", "c,ủa"); không tính dấu '/' vì "N/A", "km/h", "m/s", "có/không" là hợp lệ
  const internalPunctRe = /^\p{L}+[.,;:!?\\]\p{L}+$/u;

  for (const tok of letterTokens) {
    const strippedEdges = tok.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    if (!strippedEdges) continue;
    if (/^n\/a$/i.test(strippedEdges)) continue;

    if (
      (TOKEN_INTERNAL_CORRUPTION_RE.test(strippedEdges) && !VALID_ALNUM_MIX_RE.test(strippedEdges)) ||
      internalPunctRe.test(strippedEdges)
    ) {
      corruptedTokens++;
    }

    // Kiểm tra kiểu OCR lỗi viết hoa/dấu lạc giữa từ như "ÐiÒu", "chuÈn", "thƯờng"
    // Bỏ qua camelCase hợp lệ ngắn kiểu "iPhone", "eLib", "macOS", "JavaScript"
    const hasNonAsciiAccentFlip =
      strippedEdges.length >= 3 &&
      /\p{Ll}(?=[^\x00-\x7F])\p{Lu}/u.test(strippedEdges);
    const hasMultiCaseFlip =
      strippedEdges.length >= 4 &&
      (strippedEdges.match(/(?:\p{Ll}\p{Lu}|\p{Lu}\p{Ll})/gu)?.length ?? 0) >= 3;
    if (hasNonAsciiAccentFlip || hasMultiCaseFlip || (strippedEdges.length >= 3 && INTERNAL_UPPER_ACCENT_RE.test(strippedEdges) && /[^\x00-\x7F]/.test(strippedEdges))) {
      internalWeirdCaseTokens++;
    }

    if (/^\p{L}+$/u.test(strippedEdges)) {
      if (strippedEdges.length === 1) {
        const lower = strippedEdges.toLowerCase();
        // Trong tiếng Việt/Anh, 'a', 'i' có thể đứng một mình tự nhiên; các chữ đơn lẻ nối tiếp nhau > 3 là dấu hiệu OCR tách chữ
        if (lower !== 'a' && lower !== 'i') {
          singleCharTokens++;
        }
        singleCharRun++;
        if (singleCharRun > maxSingleCharRun) maxSingleCharRun = singleCharRun;
      } else {
        singleCharRun = 0;
        const isAllCaps = strippedEdges === strippedEdges.toUpperCase() && strippedEdges !== strippedEdges.toLowerCase();
        const isRoman = /^[ivxlcdm]+$/i.test(strippedEdges);
        if (strippedEdges.length >= 4 && !isAllCaps && !isRoman) {
          pureWordCount++;
          if (!VOWEL_RE.test(strippedEdges) || EXCESSIVE_CONSONANTS_RE.test(strippedEdges)) {
            vowellessWords++;
          }
        }
      }
    } else {
      singleCharRun = 0;
    }
  }

  const corruptedTokenRatio = letterTokens.length > 0 ? corruptedTokens / letterTokens.length : 0;
  const weirdCaseRatio = letterTokens.length >= 10 ? internalWeirdCaseTokens / letterTokens.length : 0;
  const vowellessRatio = pureWordCount >= 8 ? vowellessWords / pureWordCount : 0;
  const singleCharRatio = letterTokens.length >= 25 ? singleCharTokens / letterTokens.length : 0;

  // Kiểm tra tiếng Việt bị mất dấu do OCR rác (không kích hoạt trên văn bản tiếng Anh)
  const viDiacriticsCount = norm.match(VIETNAMESE_SPECIFIC_DIACRITICS_RE)?.length ?? 0;
  const viDiacriticRatio = letterCount > 0 ? viDiacriticsCount / letterCount : 0;

  const lowerAlphaTokens = letterTokens
    .map((t) => t.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase())
    .filter((t) => t.length >= 3);

  let viMarkerHits = 0;
  const distinctViMarkers = new Set<string>();
  for (const w of lowerAlphaTokens) {
    if (STRIPPED_VIETNAMESE_MARKERS.has(w)) {
      viMarkerHits++;
      distinctViMarkers.add(w);
    }
  }
  const strippedVietnameseSignal =
    letterCount >= 120 &&
    viMarkerHits >= 6 &&
    distinctViMarkers.size >= 4 &&
    viDiacriticRatio < 0.015;

  // Phát hiện trang có chữ cái quá thưa so với ký tự lạ/số (trừ trang bảng biểu hợp lệ)
  const nonAsciiJunkRatio =
    (norm.match(/[^\p{L}\p{N}\s.,;:!?()[\]{}"'“”‘’\-–—/+*%°=<>@#&_~^\\|]/gu)?.length ?? 0) / rawLen;

  // Trang có văn bản tiếng Việt có dấu sạch (không hard_garbage/mojibake/weirdCase/corrupted)
  // thường chỉ kích hoạt fragmented_chars / vowelless_words do chứa bảng ký hiệu/công thức toán học (a, b, d, dB, Inf...)
  const hasCleanVietnameseProse =
    viDiacriticRatio >= 0.04 &&
    viDiacriticsCount >= 12 &&
    hardGarbageRatio <= 0.015 &&
    mojibakeRatio <= 0.015 &&
    weirdCaseRatio <= 0.06 &&
    corruptedTokenRatio <= 0.08;

  let penalty = 0;
  if (hardGarbageRatio > 0.015) {
    penalty += Math.min(0.6, hardGarbageRatio * 8);
    reasons.push(`hard_garbage(${(hardGarbageRatio * 100).toFixed(1)}%)`);
  }
  if (mojibakeRatio > 0.015) {
    penalty += Math.min(0.6, mojibakeRatio * 8);
    reasons.push(`mojibake(${(mojibakeRatio * 100).toFixed(1)}%)`);
  }
  if (weirdRatio > 0.05) {
    penalty += Math.min(0.4, weirdRatio * 3);
    reasons.push(`weird_symbols(${(weirdRatio * 100).toFixed(1)}%)`);
  }
  if (corruptedTokenRatio > 0.08) {
    penalty += Math.min(0.55, corruptedTokenRatio * 2.5);
    reasons.push(`corrupted_tokens(${(corruptedTokenRatio * 100).toFixed(1)}%)`);
  }
  if (weirdCaseRatio > 0.06) {
    penalty += Math.min(0.5, weirdCaseRatio * 3);
    reasons.push(`broken_encoding_case(${(weirdCaseRatio * 100).toFixed(1)}%)`);
  }
  const vowellessThreshold = hasCleanVietnameseProse ? 0.45 : 0.18;
  if (vowellessRatio > vowellessThreshold) {
    penalty += Math.min(0.55, vowellessRatio * 2);
    reasons.push(`vowelless_words(${(vowellessRatio * 100).toFixed(1)}%)`);
  }
  // Tránh báo nhầm trang sạch có bảng/công thức hoặc 1 dòng banner giãn chữ (T I Ê U C H U Ẩ N)
  const fragmentedTriggered = hasCleanVietnameseProse
    ? singleCharRatio > 0.35
    : singleCharRatio > 0.30 || (maxSingleCharRun >= 8 && singleCharRatio >= 0.14);
  if (fragmentedTriggered) {
    penalty += 0.45;
    reasons.push(`fragmented_chars(ratio=${(singleCharRatio * 100).toFixed(1)}%,run=${maxSingleCharRun})`);
  }
  if (nonAsciiJunkRatio > 0.05) {
    penalty += Math.min(0.45, nonAsciiJunkRatio * 4);
    reasons.push(`non_ascii_junk(${(nonAsciiJunkRatio * 100).toFixed(1)}%)`);
  }
  if (strippedVietnameseSignal) {
    penalty += 0.55;
    reasons.push(`stripped_vi_diacritics(markers=${viMarkerHits},diacriticRatio=${(viDiacriticRatio * 100).toFixed(2)}%)`);
  }

  const score = Math.max(0, Math.min(1, Math.round((1 - penalty) * 100) / 100));
  const isGarbled =
    reasons.length > 0 &&
    (hardGarbageRatio > 0.025 ||
      mojibakeRatio > 0.025 ||
      corruptedTokenRatio > 0.12 ||
      weirdCaseRatio > 0.10 ||
      vowellessRatio > (hasCleanVietnameseProse ? 0.45 : 0.25) ||
      singleCharRatio > 0.35 ||
      (!hasCleanVietnameseProse && maxSingleCharRun >= 10 && singleCharRatio >= 0.14) ||
      strippedVietnameseSignal ||
      score < 0.55);

  if (isGarbled) {
    return {
      quality: 'garbled_ocr',
      score,
      needsOcr: true,
      reasons,
    };
  }

  return {
    quality: 'good',
    score,
    needsOcr: false,
    reasons,
  };
}
