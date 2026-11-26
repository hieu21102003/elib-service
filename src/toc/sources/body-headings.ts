import { isMultiColumnTableRow } from '../line-builder.js';
import {
  clampConfidence,
  cleanTocTitle,
  isJunkTitle,
  isTableOrFigureCaption,
  isVirtualFirstPageTitle,
  normalizeUnicode,
} from '../normalize.js';
import type { PageLine, PageProfile, SuspiciousNode, TocNode } from '../types.js';

type HeadingKind =
  | 'unnumbered_structural'
  | 'phan'
  | 'chuong'
  | 'muc'
  | 'tieumuc'
  | 'dieu'
  | 'phuluc'
  | 'chapter'
  | 'annex'
  | 'annex_letter'
  | 'annex_sub'
  | 'decimal';

interface CandidateHeading {
  title: string;
  kind: HeadingKind;
  depthHint: number;
  pageNumber: number;
  y: number;
  x: number;
  fontSize: number;
  isBold: boolean;
  isAllCaps: boolean;
  isCentered: boolean;
  dieuNumber?: number;
  inAnnex: boolean;
  annexId: number;
  confidence: number;
}

const LEGAL_BOILERPLATE_RE =
  /^(?:CỘNG\s+HÒA\s+XÃ\s+HỘI\s+CHỦ\s+NGHĨA\s+VIỆT\s+NAM|Độc\s+lập\s*-\s*Tự\s+do\s*-\s*Hạnh\s+phúc|BỘ\s+[A-ZÀ-Ỹ\s]{3,}|CHÍNH\s+PHỦ|THỦ\s+TƯỚNG\s+CHÍNH\s+PHỦ|Nơi\s+nhận\s*:|KT\.\s*BỘ\s+TRƯỞNG|QUYỀN\s+BỘ\s+TRƯỞNG|BỘ\s+TRƯỞNG|THỨ\s+TRƯỞNG|CHỦ\s+TỊCH|Hà\s+Nội,\s+ngày\s+\d+|Số:\s*\d+\/)/i;

const FOOTNOTE_PREFIX_RE =
  /^(?:\d{1,3}|[*†‡§]+|\[\d{1,3}\])\s+(?:Điều|Khoản|Chương|Mục|Theo|Xem|Sửa\s+đổi|Bổ\s+sung|Bãi\s+bỏ|Cụm\s+từ|Văn\s+bản|Luật|Nghị\s+định|Thông\s+tư)\b/i;

const QUOTE_OPEN_START_RE = /^["“‘'«„]/;

const DIEU_CITATION_PROSE_RE =
  /^Điều\s+\d+[a-z]?\s+(?:của|được|này|trên|đó|và|hoặc|tại|theo|bị|có|không|phải|về|quy\s+định\s+tại)\b/i;

const PHAN_RE = /^Phần\s+(?:thứ\s+)?(?:[IVXLCDM]+|\d+|nhất|hai|ba|tư|năm)(?=\s|[.:–—-]|$)/i;
const CHUONG_RE = /^Chương\s+(?:[IVXLCDM]+|\d+)(?=\s|[.:–—-]|$)/i;
// Tránh khớp nhầm chữ thường "mục công trình..." (vì \b ASCII tách giữa "c" và "ô")
const MUC_RE = /^(?:Mục|MỤC)\s+(?:\d+|[IVXLCDM]+)(?=\s|[.:–—-]|$)/;
const TIEUMUC_RE = /^(?:Tiểu\s+mục|TIỂU\s+MỤC)\s+(?:\d+|[IVXLCDM]+)(?=\s|[.:–—-]|$)/;
const DIEU_STRICT_RE = /^Điều\s+(\d+)[a-z]?(?:\s*[.:]\s*|\s+)(.*)$/i;
const PHU_LUC_RE = /^Phụ\s+lục(?:\s+(?:[IVXLCDM]+|\d+|[A-Z]))?(?=\s|[.:–—-]|$)/i;
const CHAPTER_RE = /^Chapter\s+(?:[IVXLCDM]+|\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)(?=\s|[.:–—-]|$)/i;
const ANNEX_RE = /^(?:Annex|Appendix)\s+[A-Z0-9]+(?:\s*\((?:informative|normative)\))?(?=\s|[.:–—-]|$)/i;
const ANNEX_LETTER_RE = /^([A-Z])\.\s+(\S.*)$/;
const ANNEX_SUB_RE = /^([A-Z])\.(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;
const DECIMAL_RE = /^(\d+(?:\.\d+)*)\.?\s+(\S.*)$/;

const UNNUMBERED_STRUCTURAL_RE =
  /^(?:Lời\s+(?:nói|mở)\s+đầu|Lời\s+giới\s+thiệu|Thư\s+mục\s+tài\s+liệu\s+tham\s+khảo|Tài\s+liệu\s+tham\s+khảo|Foreword|Introduction|Bibliography)$/i;

const PHAN_PROSE_RE =
  /^Phần\s+(?:thứ\s+)?(?:[IVXLCDM]+|\d+|nhất|hai|ba|tư|năm)\s+(?:của|này|trên|đó|nêu|mô\s+tả|quy\s+định|trình\s+bày|đưa\s+ra|bao\s+gồm)\b/i;

const PHU_LUC_PROSE_CITATION_RE =
  /^Phụ\s+lục(?:\s+(?:[IVXLCDM]+|\d+|[A-Z]))?\s+(?:của\s+(?:Thông\s+tư|Nghị\s+định|Quy\s+chuẩn|Luật|Quyết\s+định|văn\s+bản|tiêu\s+chuẩn)|ban\s+hành\s+kèm\s+theo|kèm\s+theo|nêu(?:\s+chi\s+tiết|\s+tại|\s+rõ|\s+các)?|đưa\s+ra|trình\s+bày|quy\s+định|mô\s+tả|hướng\s+dẫn|bao\s+gồm|liệt\s+kê|cung\s+cấp|xác\s+định|theo\s+mẫu|là|có|được|sẽ|này)\b/i;

const BARE_DECIMAL_SUB_RE = /^(\d+(?:\.\d+)+)\.?$/;

const FORM_PLACEHOLDER_RE = /(?:…|\.{3,}|…\s*\(\d+\)|\(\d+\)\s*…)/;

const STRUCTURAL_LABEL_ONLY_RE =
  /^(?:Phần\s+(?:thứ\s+)?(?:[IVXLCDM]+|\d+|nhất|hai|ba|tư|năm)|Chương\s+(?:[IVXLCDM]+|\d+)|Mục\s+(?:\d+|[IVXLCDM]+)|Tiểu\s+mục\s+(?:\d+|[IVXLCDM]+)|Phụ\s+lục(?:\s+(?:[IVXLCDM]+|\d+|[A-Z]))?|Chapter\s+(?:[IVXLCDM]+|\d+)|Annex\s+[A-Z0-9]+(?:\s*\((?:informative|normative)\))?:?|Appendix\s+[A-Z0-9]+:?)\s*$/i;

const DOT_LEADER_TRAILING_PAGE_RE =
  /(?:\.{3,}|…+|(?:\.\s+){2,}|_{3,})\s*(?:[ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})\s*$/i;

function isDotLeaderTocLine(line: PageLine, text: string): boolean {
  if (DOT_LEADER_TRAILING_PAGE_RE.test(text)) return true;
  if (line.hasDotLeader && line.trailingPageToken !== null && /(?:\.{2,}|…+|(?:\.\s+){2,})/.test(text)) {
    return true;
  }
  return false;
}

function computeBodyStats(pages: PageProfile[]): {
  bodyFontSize: number;
  bodyLeftMargin: number;
  hasIndentedBodyForLeftHeadings: boolean;
} {
  const sizeWeights = new Map<number, number>();
  const leftXList: number[] = [];

  for (const page of pages) {
    if (page.quality !== 'good') continue;
    for (const line of page.lines) {
      if (line.isHeaderFooter || line.isTocLine) continue;
      const len = line.text.replace(/\s+/g, '').length;
      if (len < 12) continue;
      const bucket = Math.round(line.fontSize * 2) / 2;
      sizeWeights.set(bucket, (sizeWeights.get(bucket) ?? 0) + len);
      if (len >= 25) leftXList.push(Math.round(line.x));
    }
  }

  let bodyFontSize = 11;
  let maxWeight = -1;
  for (const [sz, w] of sizeWeights.entries()) {
    if (w > maxWeight) {
      maxWeight = w;
      bodyFontSize = sz;
    }
  }

  let bodyLeftMargin = 50;
  let minLeftX = 50;
  let hasIndentedBodyForLeftHeadings = false;
  if (leftXList.length >= 10) {
    leftXList.sort((a, b) => a - b);
    bodyLeftMargin = leftXList[Math.floor(leftXList.length * 0.5)];
    minLeftX = leftXList[Math.floor(leftXList.length * 0.05)];
    if (bodyLeftMargin - minLeftX >= 10) {
      hasIndentedBodyForLeftHeadings = true;
    }
  }

  return {
    bodyFontSize,
    bodyLeftMargin: hasIndentedBodyForLeftHeadings ? minLeftX : bodyLeftMargin,
    hasIndentedBodyForLeftHeadings,
  };
}

function isTableLikeRow(line: PageLine): boolean {
  return isMultiColumnTableRow(line);
}

function startsHeadingPrefix(text: string): boolean {
  return (
    PHAN_RE.test(text) ||
    CHUONG_RE.test(text) ||
    MUC_RE.test(text) ||
    TIEUMUC_RE.test(text) ||
    /^Điều\s+\d+[a-z]?\s*[.:]/i.test(text) ||
    PHU_LUC_RE.test(text) ||
    CHAPTER_RE.test(text) ||
    ANNEX_RE.test(text) ||
    ANNEX_SUB_RE.test(text) ||
    /^\d+(?:\.\d+)+\.?\s+/.test(text)
  );
}

function classifyLine(
  text: string,
  line: PageLine,
  bodyFontSize: number,
  bodyLeftMargin: number,
  hasIndentedBody: boolean,
  hasDieuSystem: boolean,
  inAnnexZone: boolean,
  allowLowercaseDecimalRest = false
): { kind: HeadingKind; depthHint: number; dieuNumber?: number; confidence: number } | null {
  const norm = normalizeUnicode(text);
  if (!norm || norm.length > 220) return null;
  if (isJunkTitle(norm) || isTableOrFigureCaption(norm) || isVirtualFirstPageTitle(norm)) return null;
  if (LEGAL_BOILERPLATE_RE.test(norm)) return null;

  const isLarger = line.fontSize >= bodyFontSize * 1.05;
  const isSlightlyLarger = line.fontSize >= bodyFontSize * 1.02;
  const isLeftProminent = hasIndentedBody && line.x <= bodyLeftMargin + 6;
  const isVisuallyProminent = line.isBold || isLarger || line.isAllCaps || line.isCentered || isLeftProminent;

  // Đề mục cấu trúc cố định không đánh số của tiêu chuẩn (Lời nói đầu, Lời giới thiệu, Thư mục tài liệu tham khảo...)
  if (
    UNNUMBERED_STRUCTURAL_RE.test(norm) &&
    (line.isBold || isLarger || line.isAllCaps || line.isCentered)
  ) {
    return {
      kind: 'unnumbered_structural',
      depthHint: 1,
      confidence: clampConfidence(0.76 + (line.isBold ? 0.12 : 0) + (isLarger ? 0.06 : 0)),
    };
  }

  if (PHAN_RE.test(norm)) {
    if (PHAN_PROSE_RE.test(norm)) return null;
    if (/[.;,]$/.test(norm) && !line.isBold && !isLarger && !line.isAllCaps && !line.isCentered) return null;
    return { kind: 'phan', depthHint: 1, confidence: clampConfidence(0.75 + (isVisuallyProminent ? 0.15 : 0)) };
  }
  if (CHUONG_RE.test(norm)) {
    return { kind: 'chuong', depthHint: 1, confidence: clampConfidence(0.76 + (isVisuallyProminent ? 0.14 : 0)) };
  }
  if (MUC_RE.test(norm)) {
    return { kind: 'muc', depthHint: 2, confidence: clampConfidence(0.74 + (isVisuallyProminent ? 0.12 : 0)) };
  }
  if (TIEUMUC_RE.test(norm)) {
    return { kind: 'tieumuc', depthHint: 3, confidence: clampConfidence(0.72 + (isVisuallyProminent ? 0.12 : 0)) };
  }
  if (PHU_LUC_RE.test(norm)) {
    if (!isVisuallyProminent && norm.length > 100) return null;
    // Tránh câu văn trích dẫn kiểu "Phụ lục IV của Thông tư này;", "Phụ lục C đưa ra ví dụ...", "Phụ lục B nêu chi tiết..."
    if (/[;,]$/.test(norm)) return null;
    if (PHU_LUC_PROSE_CITATION_RE.test(norm)) return null;
    if (norm.endsWith('.') && norm.length > 45 && !line.isBold && !line.isAllCaps && !line.isCentered) return null;
    if (/\.\s+[\p{Lu}][\p{Ll}]/u.test(norm) && !line.isAllCaps) return null;
    // Tránh nhãn ngắn kết thúc bằng dấu chấm ở cuối câu văn bị xuống dòng (vd "Phụ lục B.")
    if (/^Phụ\s+lục\s+(?:[IVXLCDM]+|\d+|[A-Z])\.$/i.test(norm) && !line.isBold && !line.isAllCaps && !line.isCentered) {
      return null;
    }
    return { kind: 'phuluc', depthHint: 1, confidence: clampConfidence(0.72 + (isVisuallyProminent ? 0.15 : 0)) };
  }

  // Điều N. Tiêu đề
  const dieuMatch = DIEU_STRICT_RE.exec(norm);
  if (dieuMatch) {
    if (DIEU_CITATION_PROSE_RE.test(norm)) return null;
    const hasDotOrColon = /^Điều\s+\d+[a-z]?\s*[.:]/i.test(norm);
    const num = Number.parseInt(dieuMatch[1], 10);
    const rest = dieuMatch[2]?.trim() ?? '';
    if (!hasDotOrColon && !line.isBold && !isLarger) return null;
    if (!hasDotOrColon && rest && /^\p{Ll}/u.test(rest)) return null;
    // Loại trích dẫn dài không in đậm kết thúc bằng dấu chấm như câu văn trích luật
    if (!hasDotOrColon && norm.length > 140) return null;
    const conf = clampConfidence(
      (hasDotOrColon ? 0.72 : 0.58) + (line.isBold ? 0.16 : 0) + (isLarger ? 0.08 : 0)
    );
    return { kind: 'dieu', depthHint: 2, dieuNumber: num, confidence: conf };
  }

  if (CHAPTER_RE.test(norm)) {
    if (!isVisuallyProminent && norm.length > 90) return null;
    return { kind: 'chapter', depthHint: 1, confidence: clampConfidence(0.74 + (isVisuallyProminent ? 0.14 : 0)) };
  }

  if (ANNEX_RE.test(norm)) {
    if (/^(?:Annex|Appendix)\s+[A-Z0-9]+\s+(?:is|contains|provides|specifies|describes|shows)\b/i.test(norm)) {
      return null;
    }
    if (/\b(?:Change|Delete|Add|Replace|Remove)\s+["“‘']|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\s+(?:Editorial|Substantive)\b/i.test(norm)) {
      return null;
    }
    if (!isVisuallyProminent && norm.length > 110) return null;
    return { kind: 'annex', depthHint: 1, confidence: clampConfidence(0.75 + (isVisuallyProminent ? 0.15 : 0)) };
  }

  const annexSubMatch = ANNEX_SUB_RE.exec(norm);
  if (annexSubMatch) {
    const rest = annexSubMatch[3].trim();
    if (/^\p{Ll}/u.test(rest) || /[;,]$/.test(rest)) return null;
    if (rest.length > 150) return null;
    if (!line.isBold && !isSlightlyLarger && !isLeftProminent && !line.isAllCaps && /[.!?]$/.test(rest)) {
      return null;
    }
    const depth = annexSubMatch[2].split('.').length + 1;
    return {
      kind: 'annex_sub',
      depthHint: Math.min(6, depth),
      confidence: clampConfidence(0.68 + (line.isBold ? 0.16 : 0) + (isLeftProminent ? 0.1 : 0)),
    };
  }

  if (inAnnexZone) {
    const annexLetterMatch = ANNEX_LETTER_RE.exec(norm);
    if (annexLetterMatch) {
      const rest = annexLetterMatch[2].trim();
      if (
        /^[\p{Lu}]/u.test(rest) &&
        rest.length >= 4 &&
        rest.length <= 120 &&
        !FORM_PLACEHOLDER_RE.test(rest) &&
        !/[.!?;,]$/.test(rest) &&
        (line.isBold || isSlightlyLarger || line.isAllCaps || isLeftProminent)
      ) {
        return {
          kind: 'annex_letter',
          depthHint: 2,
          confidence: clampConfidence(0.68 + (line.isBold ? 0.14 : 0) + (isLeftProminent ? 0.08 : 0)),
        };
      }
    }
  }

  const decMatch = DECIMAL_RE.exec(norm);
  if (decMatch) {
    const prefix = decMatch[1];
    const rest = decMatch[2].trim();
    const parts = prefix.split('.');
    const topNum = Number.parseInt(parts[0], 10);

    // Chặn năm/số lớn kiểu "2025. ..." hoặc "1998. ..."
    if (topNum > 100) return null;
    // Dùng \p{Ll} thay cho [a-zà-ỹ] vì 'Đ' (U+0110) nằm trong dải [à-ỹ] (U+00E0..U+1EF9)!
    if ((!allowLowercaseDecimalRest && /^\p{Ll}/u.test(rest)) || /[;,]$/.test(rest)) return null;
    // Chặn dòng tham chiếu có đơn vị đo ("1.2 kg...", "20.5 %") — dùng lookahead khoảng trắng/dấu câu thay vì \b ASCII
    // để không chặn nhầm từ tiếng Việt bắt đầu bằng S/V/A + nguyên âm có dấu ("Sức kháng", "Vật liệu", "Sự lãnh đạo")!
    if (/^(?:%|kg|km|mm|cm|m2|m3|hz|khz|mhz|ghz|db|ms|s|v|a|w)(?=\s|$|[,.;:)\]])/i.test(rest)) return null;
    if (rest.length > 160) return null;

    // Trong Phụ lục: loại bỏ dòng biểu mẫu điền trống có dấu chấm lửng ("1.1. Ga: …", "2.1 Công trình…")
    if (inAnnexZone && FORM_PLACEHOLDER_RE.test(norm)) {
      return null;
    }

    // Nếu tài liệu dùng hệ Điều 1..N ở thân chính và đang chưa vào Phụ lục -> không nhận khoản "1.", "2."
    if (hasDieuSystem && !inAnnexZone) {
      if (parts.length === 1) return null;
      if (!line.isBold && !isLarger) return null;
    }

    if (parts.length === 1) {
      // Mục cấp 1 ("1. Title") dễ lẫn với danh sách đánh số 1. 2. 3. -> yêu cầu dấu hiệu thị giác rõ
      const strongProminence =
        line.isBold ||
        isLarger ||
        line.isAllCaps ||
        (isLeftProminent && !/[.!?]$/.test(rest) && rest.length <= 100);
      if (!strongProminence) return null;
      if (/[.!?]$/.test(rest) && !line.isBold && !isLarger && !line.isAllCaps) return null;
    } else {
      // Chặn câu văn đánh số kết thúc bằng dấu chấm/chấm hỏi/chấm than hoặc ", theo X.Y.Z."
      if (/[.!?]$/.test(rest) && !line.isBold && !isSlightlyLarger && !line.isAllCaps) return null;
      if (parts.length >= 3 && (/[.!?]$/.test(rest) || /,\s*theo\s+\d+(?:\.\d+)*\.?$/i.test(rest))) return null;
      const subProminent =
        line.isBold ||
        isSlightlyLarger ||
        line.isAllCaps ||
        isLeftProminent ||
        (rest.length <= 90 && !/[.!?]$/.test(rest) && /^[\p{Lu}]/u.test(rest));
      if (!subProminent) return null;
    }

    return {
      kind: 'decimal',
      depthHint: Math.min(6, parts.length),
      confidence: clampConfidence(
        0.6 +
          (line.isBold ? 0.18 : 0) +
          (isLarger ? 0.1 : 0) +
          (isLeftProminent ? 0.1 : 0) +
          (parts.length >= 2 ? 0.05 : 0)
      ),
    };
  }

  return null;
}

function shouldMergeWithNextLine(
  cur: PageLine,
  next: PageLine,
  curNorm: string,
  bodyFontSize: number
): boolean {
  if (next.isHeaderFooter || next.isTocLine) return false;
  const vGap = cur.y - next.y;
  const maxStep = Math.max(cur.fontSize, next.fontSize) * 2.15;
  if (vGap < 0 || vGap > maxStep) return false;

  const nextNorm = normalizeUnicode(next.text);
  if (!nextNorm || nextNorm.length > 140) return false;
  if (isDotLeaderTocLine(next, nextNorm)) return false;
  if (startsHeadingPrefix(nextNorm)) return false;
  if (isTableOrFigureCaption(nextNorm) || LEGAL_BOILERPLATE_RE.test(nextNorm)) return false;
  if (QUOTE_OPEN_START_RE.test(nextNorm) || FOOTNOTE_PREFIX_RE.test(nextNorm)) return false;
  if (isTableLikeRow(next)) return false;
  // Tránh dính dòng tiêu đề cột bảng (nhiều khoảng trắng cột lớn trên dòng kế hoặc thụt ngang khác hẳn tiêu đề)
  let wideGapsInNext = 0;
  for (let k = 1; k < next.runs.length; k++) {
    if (next.runs[k].x - next.runs[k - 1].xEnd >= Math.max(18, next.fontSize * 1.6)) {
      wideGapsInNext++;
    }
  }
  if (wideGapsInNext >= 2) return false;
  if (!STRUCTURAL_LABEL_ONLY_RE.test(curNorm) && Math.abs(next.x - cur.x) > 45 && !cur.isCentered && !next.isCentered) {
    return false;
  }

  // Trường hợp 1: dòng 1 là nhãn cấu trúc đứng riêng ("Chương I", "Phụ lục A", "Annex ZZ (informative):")
  if (STRUCTURAL_LABEL_ONLY_RE.test(curNorm)) {
    const nextProminent =
      next.isBold ||
      next.isAllCaps ||
      next.isCentered ||
      next.fontSize >= bodyFontSize * 1.03 ||
      Math.abs(next.fontSize - cur.fontSize) <= 1.5;
    return nextProminent && nextNorm.length <= 130;
  }

  // Trường hợp 2: cùng cỡ chữ & cùng kiểu bold (tiêu đề dài xuống dòng 2-3)
  const sameSize = Math.abs(cur.fontSize - next.fontSize) <= 0.7;
  const sameBold = cur.isBold === next.isBold;
  if (!sameSize || !sameBold) return false;

  // Không gộp nếu dòng trước kết thúc bằng dấu chấm kết câu hoàn chỉnh (trừ sau nhãn "Điều 1." chưa có tên hoặc tiêu đề ngắn)
  if (/[.!?]$/.test(curNorm) && !/^Điều\s+\d+[a-z]?\s*[.:]$/i.test(curNorm) && curNorm.length > 30) {
    return false;
  }
  // Chỉ gộp tiếp khi dòng sau vẫn giữ phong cách tiêu đề hoặc tiếp nối cụm từ dở
  const nextLooksContinuation =
    cur.isBold ||
    cur.fontSize >= bodyFontSize * 1.05 ||
    cur.isAllCaps ||
    cur.isCentered ||
    /[,\-–:/]$/.test(curNorm);

  return nextLooksContinuation;
}

/**
 * Quét tiêu đề từ thân bài (chỉ dùng trên các trang `good` và bỏ qua trang Mục lục).
 * Xử lý ghép dòng tiêu đề 2-3 dòng, lọc chú thích cuối trang, lọc trích dẫn "Điều N" giả trong ngoặc kép.
 */
export function extractBodyHeadings(
  pages: PageProfile[],
  excludedTocPages: number[] = []
): {
  nodes: TocNode[];
  suspiciousNodes: SuspiciousNode[];
} {
  const excludedSet = new Set(excludedTocPages);
  // Trang Contents: nếu đã có đánh dấu từng dòng `isTocLine` (hỗ trợ trang trộn Contents + thân bài),
  // chỉ bỏ các dòng `isTocLine`; nếu không có đánh dấu từng dòng thì bỏ nguyên trang trong `excludedTocPages`.
  const goodPages = pages.filter((p) => {
    if (p.quality !== 'good') return false;
    if (!excludedSet.has(p.pageNumber)) return true;
    return p.lines.some((l) => l.isTocLine === true) && p.lines.some((l) => !l.isHeaderFooter && !l.isTocLine);
  });
  if (goodPages.length === 0) {
    return { nodes: [], suspiciousNodes: [] };
  }

  const { bodyFontSize, bodyLeftMargin, hasIndentedBodyForLeftHeadings } = computeBodyStats(goodPages);

  // Kiểm tra sơ bộ xem tài liệu có dùng hệ thống Điều 1..N hay không
  let dieuMatchesCount = 0;
  for (const page of goodPages) {
    for (const l of page.lines) {
      if (l.isHeaderFooter || l.isTocLine) continue;
      if (isDotLeaderTocLine(l, l.text)) continue;
      if (/^Điều\s+\d+[a-z]?\s*[.:]/i.test(l.text) && (l.isBold || l.fontSize >= bodyFontSize * 0.98)) {
        dieuMatchesCount++;
      }
    }
  }
  const hasDieuSystem = dieuMatchesCount >= 2;

  const candidates: CandidateHeading[] = [];
  const suspiciousNodes: SuspiciousNode[] = [];
  let inAnnexZone = false;
  let currentAnnexId = 0;

  const FIGURE_LEGEND_HEADER_RE = /^(?:CHÚ\s+DẪN|Chú\s+dẫn|KEY|LEGEND)\b/i;
  const EQUATION_LINE_RE = /[∙·×=±≤≥∑∫].*\((?:[A-Z]\.)?\d+(?:\.\d+)?\)\s*$/;

  for (const page of goodPages) {
    const lines = page.lines.filter((l) => !l.isHeaderFooter && !l.isTocLine);
    let openCurlyQuote = false;
    let inFigureLegendZone = false;
    const pageHasFigureCaption = lines.some((l) => /^(?:Hình|Figure|Fig\.?)\s+(?:[A-Z]\.)?\d+/i.test(normalizeUnicode(l.text)));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = normalizeUnicode(line.text);
      if (!text) continue;
      if (isDotLeaderTocLine(line, text)) continue;
      if (EQUATION_LINE_RE.test(text)) continue;

      if (FIGURE_LEGEND_HEADER_RE.test(text)) {
        inFigureLegendZone = true;
        continue;
      }
      // Thoát vùng chú dẫn hình khi gặp tiêu đề lớn/đậm rõ ràng (hoặc caption Hình N kết thúc khối chú dẫn)
      if (
        inFigureLegendZone &&
        (line.fontSize >= bodyFontSize * 1.05 ||
          /^(?:Hình|Figure|Fig\.?)\s+/i.test(text) ||
          /^(?:Phụ\s+lục|Annex|Appendix)\b/i.test(text) ||
          /^\d+\.\d+/.test(text))
      ) {
        inFigureLegendZone = false;
      }
      // Trong vùng chú dẫn hình: bỏ qua các dòng đánh số ngắn kiểu "1 Khung phun nước", "2 Vòi phun..."
      if (inFigureLegendZone && /^\d{1,2}\.?\s+\S/.test(text) && line.fontSize < bodyFontSize * 1.05) {
        continue;
      }

      const openQuotes = (text.match(/“/g) ?? []).length;
      const closeQuotes = (text.match(/”/g) ?? []).length;
      const startsWithQuote = QUOTE_OPEN_START_RE.test(text);

      // Lọc trích dẫn nằm trong ngoặc kép (vd "Điều 57. ..." trong văn bản hợp nhất/sửa đổi)
      if (openCurlyQuote || startsWithQuote) {
        if (startsWithQuote && /^["“‘'«„]\s*Điều\s+\d+/i.test(text)) {
          suspiciousNodes.push({
            title: text.slice(0, 120),
            page_pdf: page.pageNumber,
            level: 2,
            source: 'body_headings',
            reason: 'filtered_quoted_dieu_citation',
          });
        }
        openCurlyQuote = openCurlyQuote ? closeQuotes <= openQuotes : openQuotes > closeQuotes;
        continue;
      }

      if (openQuotes !== closeQuotes) {
        openCurlyQuote = openQuotes > closeQuotes;
      }

      // Lọc chú thích cuối trang (cỡ chữ nhỏ ở đáy trang hoặc đánh số chú thích)
      const isFootnoteZone = line.fontSize < bodyFontSize * 0.88 && line.y < page.height * 0.35;
      if (isFootnoteZone || FOOTNOTE_PREFIX_RE.test(text)) {
        if (/Điều\s+\d+/i.test(text)) {
          suspiciousNodes.push({
            title: text.slice(0, 120),
            page_pdf: page.pageNumber,
            level: 2,
            source: 'body_headings',
            reason: 'filtered_footnote_citation',
          });
        }
        continue;
      }

      if (isTableLikeRow(line)) continue;

      // Thử ghép tiêu đề xuống 2-3 dòng liền kề trước khi phân loại
      let mergedText = text;
      let consumed = 0;
      let mergedFromBareDecimal = false;

      // Trường hợp số mục con đứng riêng 1 dòng (vd "3.1" đậm, dòng kế tiếp là tên thuật ngữ "bên mua (purchaser)" hoặc "Tàu")
      if (
        BARE_DECIMAL_SUB_RE.test(text) &&
        (line.isBold || line.fontSize >= bodyFontSize * 0.98) &&
        i + 1 < lines.length
      ) {
        const nextLine = lines[i + 1];
        const nextNorm = normalizeUnicode(nextLine.text);
        const vGap = line.y - nextLine.y;
        const maxStep = Math.max(line.fontSize, nextLine.fontSize) * 2.4;
        if (
          !nextLine.isHeaderFooter &&
          !nextLine.isTocLine &&
          vGap >= 0 &&
          vGap <= maxStep &&
          nextNorm.length >= 2 &&
          nextNorm.length <= 120 &&
          !startsHeadingPrefix(nextNorm) &&
          !BARE_DECIMAL_SUB_RE.test(nextNorm) &&
          !isTableOrFigureCaption(nextNorm) &&
          !isDotLeaderTocLine(nextLine, nextNorm) &&
          !isTableLikeRow(nextLine) &&
          !/[.!?;,]$/.test(nextNorm)
        ) {
          mergedText = `${text} ${nextNorm}`.replace(/\s+/g, ' ').trim();
          consumed = 1;
          mergedFromBareDecimal = true;
        }
      }

      const looksLikePotentialHeadingStart =
        !mergedFromBareDecimal &&
        (startsHeadingPrefix(text) ||
          STRUCTURAL_LABEL_ONLY_RE.test(text) ||
          /^Điều\s+\d+/i.test(text) ||
          /^\d+(?:\.\d+)*\.?\s+\S/.test(text));

      if (looksLikePotentialHeadingStart) {
        let prevLine = line;
        for (let step = 1; step <= 2 && i + step < lines.length; step++) {
          const nextLine = lines[i + step];
          if (!shouldMergeWithNextLine(prevLine, nextLine, mergedText, bodyFontSize)) {
            break;
          }
          mergedText = `${mergedText} ${normalizeUnicode(nextLine.text)}`.replace(/\s+/g, ' ').trim();
          consumed = step;
          prevLine = nextLine;
        }
      }

      if (DOT_LEADER_TRAILING_PAGE_RE.test(mergedText)) continue;

      const classified = classifyLine(
        mergedText,
        line,
        bodyFontSize,
        bodyLeftMargin,
        hasIndentedBodyForLeftHeadings,
        hasDieuSystem,
        inAnnexZone,
        mergedFromBareDecimal
      );

      if (!classified) continue;

      // Chặn chú giải hình đánh số ("1 Khung phun nước", "8 Nhiệt độ...") trên trang có Hình khi không lớn hơn thân bài và không đậm
      if (
        pageHasFigureCaption &&
        classified.kind === 'decimal' &&
        classified.depthHint === 1 &&
        line.fontSize < bodyFontSize * 1.05 &&
        !line.isBold
      ) {
        continue;
      }

      if (classified.kind === 'phuluc' || classified.kind === 'annex') {
        inAnnexZone = true;
        currentAnnexId++;
      } else if (classified.kind === 'annex_sub' && !inAnnexZone) {
        inAnnexZone = true;
        currentAnnexId++;
      } else if (
        classified.kind === 'unnumbered_structural' &&
        /^(?:Thư\s+mục\s+tài\s+liệu\s+tham\s+khảo|Tài\s+liệu\s+tham\s+khảo|Bibliography)$/i.test(
          normalizeUnicode(mergedText)
        )
      ) {
        // Thư mục tài liệu tham khảo / Bibliography nằm cuối tiêu chuẩn, ngang cấp 1 ngoài Phụ lục
        inAnnexZone = false;
      }

      // Khử tiền tố số hiệu lặp ở đầu/cuối dòng song ngữ (vd "3.4.6 3.4.6 Đệm..." hoặc "3.4.7 Vùng tác dụng... 3.4.7")
      let dedupedText = mergedText.replace(/^(\d+(?:\.\d+)*)\.?\s+\1\.?\s+/, '$1 ');
      const leadSec = /^(\d+(?:\.\d+)+)\b/.exec(dedupedText);
      if (leadSec && dedupedText.endsWith(` ${leadSec[1]}`)) {
        dedupedText = dedupedText.slice(0, -(leadSec[1].length + 1)).trim();
      }
      const cleaned = cleanTocTitle(dedupedText);
      if (isJunkTitle(cleaned.title) || isTableOrFigureCaption(cleaned.title)) {
        continue;
      }

      candidates.push({
        title: cleaned.title,
        kind: classified.kind,
        depthHint: classified.depthHint,
        pageNumber: page.pageNumber,
        y: line.y,
        x: line.x,
        fontSize: line.fontSize,
        isBold: line.isBold,
        isAllCaps: line.isAllCaps,
        isCentered: line.isCentered,
        dieuNumber: classified.dieuNumber,
        inAnnex: inAnnexZone,
        annexId: currentAnnexId,
        confidence: classified.confidence,
      });

      i += consumed;
    }
  }

  // Loại dòng tên phần của bộ tiêu chuẩn trên trang bìa/tiêu đề ("PHẦN 1: YÊU CẦU CHUNG", "Phần 2: ...")
  // khi tài liệu chỉ có 1 số Phần duy nhất ở đầu sách (<= tr.5) và thân bài dùng hệ mục thập phân 1, 2, 3...
  const phanNumbers = new Set(
    candidates
      .filter((c) => c.kind === 'phan')
      .map((c) => /^Phần\s+(\d+)\s*:/i.exec(c.title)?.[1])
      .filter((x): x is string => Boolean(x))
  );
  const mainDecimalL1Count = candidates.filter(
    (c) => !c.inAnnex && c.kind === 'decimal' && c.depthHint === 1
  ).length;
  const isSinglePartCoverSubtitle =
    phanNumbers.size === 1 &&
    mainDecimalL1Count >= 2 &&
    candidates.filter((c) => c.kind === 'phan').every((c) => c.pageNumber <= 8 && /^Phần\s+\d+\s*:/i.test(c.title));

  // Lọc đơn điệu cho Điều N (reset ngữ cảnh hoàn toàn mỗi khi mở một Phụ lục / Annex mới)
  const filteredByDieuOrder: CandidateHeading[] = [];
  let lastDieuNum = 0;
  let lastAnnexId = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    if (isSinglePartCoverSubtitle && c.kind === 'phan') {
      continue;
    }
    if (c.kind === 'phuluc' || c.kind === 'annex') {
      lastDieuNum = 0;
      lastAnnexId = c.annexId;
      filteredByDieuOrder.push(c);
      continue;
    }
    if (c.annexId !== lastAnnexId) {
      lastDieuNum = 0;
      lastAnnexId = c.annexId;
    }
    if (c.kind !== 'dieu' || c.dieuNumber === undefined) {
      filteredByDieuOrder.push(c);
      continue;
    }

    const n = c.dieuNumber;
    if (lastDieuNum === 0) {
      if (n <= 5 || candidates.slice(idx + 1, idx + 4).some((x) => x.kind === 'dieu' && x.annexId === c.annexId && (x.dieuNumber ?? 0) > n)) {
        lastDieuNum = n;
        filteredByDieuOrder.push(c);
      } else {
        suspiciousNodes.push({
          title: c.title,
          page_pdf: c.pageNumber,
          level: c.depthHint,
          source: 'body_headings',
          reason: `suspicious_initial_dieu_jump(Điều_${n})`,
        });
      }
      continue;
    }

    if (n > lastDieuNum) {
      // Nếu nhảy vọt quá xa (> 15) nhưng Điều tiếp theo cùng nhánh lại quay về gần lastDieuNum -> trích dẫn giả
      if (n - lastDieuNum > 15) {
        const nextDieu = candidates.slice(idx + 1, idx + 6).find((x) => x.kind === 'dieu' && x.annexId === c.annexId);
        if (nextDieu?.dieuNumber !== undefined && nextDieu.dieuNumber < n && nextDieu.dieuNumber >= lastDieuNum) {
          suspiciousNodes.push({
            title: c.title,
            page_pdf: c.pageNumber,
            level: c.depthHint,
            source: 'body_headings',
            reason: `non_monotonic_dieu_spike(Điều_${n}_between_${lastDieuNum}_and_${nextDieu.dieuNumber})`,
          });
          continue;
        }
      }
      lastDieuNum = n;
      filteredByDieuOrder.push(c);
    } else {
      // Cho phép cùng số Điều nếu là bổ sung dạng "Điều 5a" sau "Điều 5"
      if (n === lastDieuNum && /^Điều\s+\d+[a-z]/i.test(c.title)) {
        filteredByDieuOrder.push(c);
        continue;
      }
      // Cho phép reset về Điều 1 khi đi sau Phụ lục/Chương/mẫu con trong phụ lục và có Điều 2 nối tiếp
      const prevCand = filteredByDieuOrder[filteredByDieuOrder.length - 1];
      const nextDieu = candidates.slice(idx + 1, idx + 4).find((x) => x.kind === 'dieu' && x.annexId === c.annexId);
      const isValidAnnexReset =
        n === 1 &&
        prevCand &&
        (prevCand.kind === 'phuluc' ||
          prevCand.kind === 'annex' ||
          prevCand.kind === 'chuong' ||
          (c.inAnnex && (prevCand.kind === 'decimal' || prevCand.kind === 'annex_letter'))) &&
        nextDieu?.dieuNumber === 2;

      if (isValidAnnexReset) {
        lastDieuNum = 1;
        filteredByDieuOrder.push(c);
      } else {
        suspiciousNodes.push({
          title: c.title,
          page_pdf: c.pageNumber,
          level: c.depthHint,
          source: 'body_headings',
          reason: `non_monotonic_dieu_regression(Điều_${n}_after_${lastDieuNum})`,
        });
      }
    }
  }

  // Chuẩn hóa level theo cấu trúc thực sự có mặt trong tài liệu (tách riêng nhánh thân chính và nhánh con của Phụ lục)
  const mainBodyCands = filteredByDieuOrder.filter((c) => !c.inAnnex);
  const hasPhan = mainBodyCands.some((c) => c.kind === 'phan');
  const hasChuong = mainBodyCands.some((c) => c.kind === 'chuong');
  const hasMuc = mainBodyCands.some((c) => c.kind === 'muc');

  let activeAnnexId = 0;
  let annexHasLetterSection = false;
  let annexHasSubTemplate = false;
  let annexHasChuong = false;
  let annexHasMuc = false;

  const nodes: TocNode[] = filteredByDieuOrder.map((c, idx) => {
    let level = c.depthHint;

    if (c.kind === 'unnumbered_structural') {
      level = 1;
    } else if (c.kind === 'phuluc' || c.kind === 'annex') {
      level = 1;
      activeAnnexId = c.annexId;
      annexHasLetterSection = false;
      annexHasSubTemplate = false;
      annexHasChuong = false;
      annexHasMuc = false;
    } else if (c.inAnnex && c.annexId === activeAnnexId && activeAnnexId > 0) {
      // Mọi Điều / Mục / mục số đánh số lại bên trong Phụ lục đều là con của nhánh Phụ lục (level >= 2)
      if (c.kind === 'annex_letter') {
        level = 2;
        annexHasLetterSection = true;
      } else if (c.kind === 'chuong') {
        level = 2;
        annexHasChuong = true;
      } else if (c.kind === 'muc') {
        level = annexHasChuong ? 3 : 2;
        annexHasMuc = true;
      } else if (c.kind === 'tieumuc') {
        level = (annexHasChuong ? 1 : 0) + (annexHasMuc ? 1 : 0) + 2;
      } else if (c.kind === 'decimal') {
        const base = annexHasLetterSection ? 2 : 1;
        level = base + c.depthHint;
        if (c.depthHint === 1 && !annexHasLetterSection) {
          annexHasSubTemplate = true;
        }
      } else if (c.kind === 'dieu') {
        level = 2 + (annexHasChuong ? 1 : 0) + (annexHasMuc ? 1 : 0) + (annexHasSubTemplate ? 1 : 0);
      } else if (c.kind === 'annex_sub') {
        level = c.depthHint;
      }
    } else {
      if (c.kind === 'phan' || c.kind === 'chapter') {
        level = 1;
      } else if (c.kind === 'chuong') {
        level = hasPhan ? 2 : 1;
      } else if (c.kind === 'muc') {
        level = (hasPhan ? 1 : 0) + (hasChuong ? 1 : 0) + 1;
      } else if (c.kind === 'tieumuc') {
        level = (hasPhan ? 1 : 0) + (hasChuong ? 1 : 0) + (hasMuc ? 1 : 0) + 1;
      } else if (c.kind === 'dieu') {
        level = hasChuong ? (hasPhan ? 3 : 2) + (hasMuc ? 1 : 0) : 1;
      }
    }

    return {
      title: c.title,
      level: Math.max(1, Math.min(6, level)),
      page_pdf: c.pageNumber,
      sort: idx + 1,
      source: 'body_headings',
      confidence: c.confidence,
    };
  });

  return { nodes, suspiciousNodes };
}
