import { isMultiColumnTableRow } from '../line-builder.js';
import {
  clampConfidence,
  cleanTocTitle,
  isJunkTitle,
  isTableOrFigureCaption,
  isVirtualFirstPageTitle,
  normalizeUnicode,
  toComparisonKey,
  tokenOverlapScore,
} from '../normalize.js';
import type {
  OffsetInfo,
  PageLine,
  PageProfile,
  PrintedTocAnchorMatch,
  PrintedTocResult,
  SuspiciousNode,
  TocNode,
} from '../types.js';

interface ParsedTocEntry {
  title: string;
  level: number;
  printedPageRaw: string;
  printedNumeric: number;
  pageKind: 'arabic' | 'roman' | 'prefixed';
  prefixGroup?: string;
  leftX: number;
  tocPageNumber: number;
  hasStructuralPrefix: boolean;
}

const TOC_HEADING_RE =
  /^(?:MỤC\s+LỤC|TABLE\s+OF\s+CONTENTS|CONTENTS|DANH\s+MỤC\s+NỘI\s+DUNG)(?:\s*\(.*\))?(?:\s+(?:PAGE|TRANG))?$/i;

const NON_TOC_LIST_HEADING_RE =
  /^(?:(?:LIST\s+OF\s+)?(?:FIGURES|TABLES)|LIST\s+OF\s+(?:ABBREVIATIONS|ACRONYMS|SYMBOLS)|DANH\s+MỤC\s+(?:BẢNG|HÌNH|CÁC\s+TỪ\s+VIẾT\s+TẮT|CHỮ\s+VIẾT\s+TẮT)|INDEX|HISTORY|ERRATA|REVISION\s+HISTORY|CHANGE\s+(?:LOG|HISTORY)|DOCUMENT\s+HISTORY)(?:\s+(?:PAGE|TRANG))?$/i;

const TOC_COLUMN_HEADER_RE =
  /^(?:(?:page|trang|mục|nội\s+dung|clause|section)|(?:(?:stt|no\.?|chương|mục|nội\s+dung|tiêu\s+đề|contents|table\s+of\s+contents|clause|section|title|heading|description|item)\s+)+(?:page|trang))$/i;

const PAGELESS_TOC_KNOWN_HEADING_RE =
  /^(?:Abstract|Preface|Foreword|Introduction|Overview|Scope|Normative\s+References|References|Glossary|Acronyms|Abbreviations|Bibliography|Acknowledgments?|Acknowledgements?|Author(?:'s|s')?\s+Address(?:es)?|Contributors?|Index|History|Lời\s+nói\s+đầu|Mở\s+đầu|Tài\s+liệu\s+tham\s+khảo)$/i;

const DOT_LEADER_LINE_RE =
  /^(.+?)\s*(?:\.{2,}|…+|(?:\.\s+){2,}|_{3,}|-{4,})\s*([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})\s*$/i;

const SIMPLE_TRAILING_PAGE_RE =
  /^(.+?)\s+([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})\s*$/i;

const STRUCTURAL_PREFIX_RE =
  /^(?:Phần\s+(?:thứ\s+)?(?:[IVXLCDM]+|\d+|nhất|hai|ba|tư|năm)|Chương\s+(?:[IVXLCDM]+|\d+)|Mục\s+(?:[IVXLCDM]+|\d+)|Tiểu\s+mục\s+(?:[IVXLCDM]+|\d+)|Điều\s+\d+[a-z]?|Phụ\s+lục\s+(?:[A-Z0-9]+|[IVXLCDM]+)?|Chapter\s+(?:[IVXLCDM]+|\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve)|Section\s+[A-Z0-9]+|Annex\s+[A-Z0-9]+|Appendix\s+[A-Z0-9]+|[A-Z]\.\d+(?:\.\d+)*|\d+(?:\.\d+)*\.?)\b/i;

const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

export function parseRomanNumeral(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const val = ROMAN_VALUES[s[i]];
    if (!val) return null;
    if (val < prev) total -= val;
    else {
      total += val;
      prev = val;
    }
  }
  return total > 0 && total <= 3999 ? total : null;
}

function parsePageToken(token: string): {
  kind: 'arabic' | 'roman' | 'prefixed';
  numeric: number;
  prefixGroup?: string;
} | null {
  const trimmed = token.trim();
  if (/^\d{1,4}$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n >= 1 && n <= 3000) {
      return { kind: 'arabic', numeric: n };
    }
    return null;
  }
  const pref = /^([A-Z])-(\d{1,4})$/.exec(trimmed);
  if (pref) {
    const n = Number.parseInt(pref[2], 10);
    if (n >= 1 && n <= 999) {
      return { kind: 'prefixed', numeric: n, prefixGroup: pref[1] };
    }
    return null;
  }
  if (/^[ivxlcdm]{1,7}$/i.test(trimmed)) {
    const val = parseRomanNumeral(trimmed);
    if (val !== null && val <= 200) {
      return { kind: 'roman', numeric: val };
    }
  }
  return null;
}

function inferLevelFromTitle(title: string, hasPhan: boolean, hasChuong: boolean): number | null {
  const t = normalizeUnicode(title);
  if (/^Phần\s+/i.test(t)) return 1;
  if (/^Chương\s+/i.test(t) || /^Chapter\s+/i.test(t)) return hasPhan ? 2 : 1;
  if (/^(?:Phụ\s+lục|Annex|Appendix)\b/i.test(t)) return 1;
  if (/^Mục\s+/i.test(t)) return (hasPhan ? 1 : 0) + (hasChuong ? 1 : 0) + 1;
  if (/^Tiểu\s+mục\s+/i.test(t)) return (hasPhan ? 1 : 0) + (hasChuong ? 1 : 0) + 2;
  if (/^Điều\s+\d+/i.test(t)) {
    if (hasChuong) return hasPhan ? 3 : 2;
    return 1;
  }
  const annexSub = /^([A-Z])\.(\d+(?:\.\d+)*)\b/.exec(t);
  if (annexSub) {
    const depth = annexSub[2].split('.').length + 1;
    return Math.min(6, depth);
  }
  const numPrefix = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(t);
  if (numPrefix) {
    const parts = numPrefix[1].split('.');
    return Math.min(6, parts.length);
  }
  return null;
}

const DATE_PREFIX_ROW_RE =
  /^(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\.\d{1,2}\.(?:19|20)\d{2})\b/;

const ERRATA_OR_CHANGE_ROW_RE =
  /\b(?:Editorial|Substantive|Typographical)\b(?:\s|$)|\b(?:Change|Delete|Replace|Remove)\s+["“‘']/i;

const NON_PAGE_PRECEDING_WORD_RE =
  /(?::|\b(?:RFC|STD|BCP|ISO|IEC|EN|TS|TR|QCVN|TCVN|January|February|March|April|May|June|July|August|September|October|November|December|Tháng|Năm))$/i;

function isValidTocTitlePart(
  titlePart: string,
  pageToken: string,
  line: PageLine,
  viaDotLeader: boolean
): boolean {
  const norm = normalizeUnicode(titlePart);
  if (norm.length < 2) return false;
  // Tiêu đề mục lục hợp lệ phải chứa ít nhất 2 chữ cái (tránh dòng chỉ có số/ký hiệu)
  const letters = norm.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return false;

  // Loại dòng bảng Errata / Changelog / Lịch sử sửa đổi kiểu "12-10-2020 Editorial ..."
  if (DATE_PREFIX_ROW_RE.test(norm)) return false;
  if (!viaDotLeader && ERRATA_OR_CHANGE_ROW_RE.test(norm)) return false;
  if (!viaDotLeader && isMultiColumnTableRow(line)) return false;

  // Khi không có chấm dẫn, tránh nhận nhầm năm/mã tiêu chuẩn ở cuối dòng (vd "Published: August 2022", "RFC: 9293")
  if (!viaDotLeader) {
    if (NON_PAGE_PRECEDING_WORD_RE.test(norm)) return false;
    if (/^\d{4}$/.test(pageToken)) {
      const n = Number.parseInt(pageToken, 10);
      if (n >= 1900 && n <= 2099) return false;
    }
  }

  return true;
}

function reconstructTitleBeforeLastRun(runs: PageLine['runs'], lastRun: PageLine['runs'][number]): string {
  const parts: string[] = [];
  let prevEnd: number | null = null;
  for (const r of runs) {
    if (r === lastRun) break;
    const t = r.text;
    if (!t) continue;
    if (prevEnd !== null && r.x - prevEnd > Math.max(1.2, r.fontSize * 0.16)) {
      if (parts.length > 0 && !parts[parts.length - 1].endsWith(' ') && !t.startsWith(' ')) {
        parts.push(' ');
      }
    }
    parts.push(t);
    prevEnd = r.xEnd;
  }
  return normalizeUnicode(parts.join('')).replace(/[.\s…_-]+$/, '').trim();
}

function extractEntryFromLine(
  line: PageLine,
  pageWidth: number
): { titlePart: string; pageToken: string; viaDotLeader: boolean } | null {
  if (line.isHeaderFooter) return null;
  const text = normalizeUnicode(line.text);
  if (!text || text.length < 3) return null;

  // 1. Dòng có chấm dẫn (kể cả khi số trang dính sát chấm dẫn như "...9" hay "..21")
  const dotMatch = DOT_LEADER_LINE_RE.exec(text);
  if (dotMatch) {
    const titlePart = dotMatch[1].replace(/[.\s…_-]+$/, '').trim();
    const pageToken = dotMatch[2].trim();
    if (parsePageToken(pageToken) && isValidTocTitlePart(titlePart, pageToken, line, true)) {
      return { titlePart, pageToken, viaDotLeader: true };
    }
  }

  // 2. Dòng Contents căn phải số trang bằng tọa độ X (kể cả khoảng trắng hẹp hoặc ranh giới cột)
  const nonSpaceRuns = line.runs.filter((r) => normalizeUnicode(r.text).length > 0);
  if (nonSpaceRuns.length >= 2 && pageWidth > 0) {
    const lastRun = nonSpaceRuns[nonSpaceRuns.length - 1];
    const prevRun = nonSpaceRuns[nonSpaceRuns.length - 2];
    const lastToken = normalizeUnicode(lastRun.text);
    const parsed = parsePageToken(lastToken);
    const realGap = lastRun.x - prevRun.xEnd;

    const isWideRightColumn =
      lastRun.x >= pageWidth * 0.65 && realGap >= Math.max(14, line.fontSize * 1.2);
    const isNarrowRightMarginColumn =
      lastRun.x >= pageWidth * 0.78 && realGap >= Math.max(1.5, line.fontSize * 0.15);

    if (parsed && (isWideRightColumn || isNarrowRightMarginColumn)) {
      const titlePart = reconstructTitleBeforeLastRun(line.runs, lastRun);
      if (isValidTocTitlePart(titlePart, lastToken, line, false)) {
        return { titlePart, pageToken: lastToken, viaDotLeader: false };
      }
    }
  }

  // 3. Fallback trường hợp không tách run riêng nhưng có >= 3 khoảng trắng trong rawText trước số trang
  const wideSpaceMatch = /^(.+?)\s{3,}([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})\s*$/i.exec(line.rawText);
  if (wideSpaceMatch) {
    const titlePart = normalizeUnicode(wideSpaceMatch[1]).replace(/[.\s…_-]+$/, '').trim();
    const pageToken = wideSpaceMatch[2].trim();
    if (parsePageToken(pageToken) && isValidTocTitlePart(titlePart, pageToken, line, false)) {
      return {
        titlePart,
        pageToken,
        viaDotLeader: false,
      };
    }
  }

  // 4. Fallback hẹp: nếu tiêu đề có tiền tố cấu trúc rõ ràng + kết thúc bằng số trang trong cùng 1 run ở mép phải
  if (line.xEnd >= pageWidth * 0.8 && SIMPLE_TRAILING_PAGE_RE.test(text)) {
    const m = SIMPLE_TRAILING_PAGE_RE.exec(text);
    if (m) {
      const titlePart = m[1].replace(/[.\s…_-]+$/, '').trim();
      const pageToken = m[2].trim();
      if (
        STRUCTURAL_PREFIX_RE.test(titlePart) &&
        parsePageToken(pageToken) &&
        isValidTocTitlePart(titlePart, pageToken, line, false) &&
        /[.)]\s*$/.test(m[1])
      ) {
        return { titlePart, pageToken, viaDotLeader: false };
      }
    }
  }

  return null;
}

function isPagelessTocEntryText(rawText: string): boolean {
  const norm = normalizeUnicode(rawText);
  if (!norm || norm.length < 3 || norm.length > 130) return false;
  if (/[.!?;]$/.test(norm)) return false;
  if (STRUCTURAL_PREFIX_RE.test(norm)) {
    // Tránh dòng mở đầu câu văn kiểu "1. In 1981, RFC 793 was released..."
    const afterNum = norm.replace(/^\d+(?:\.\d+)*\.?\s+/, '');
    if (afterNum.length > 95) return false;
    return true;
  }
  return PAGELESS_TOC_KNOWN_HEADING_RE.test(norm);
}

interface PageTocAnalysis {
  hasTocHeading: boolean;
  tocHeadingLineIdx: number;
  tocLineCount: number;
  dotLeaderCount: number;
  hasNonTocListHeading: boolean;
  pagelessTocCount: number;
  pagelessEndLineIdx: number;
  isPagelessBodyTransition: boolean;
}

function analyzePageForToc(page: PageProfile, continuingPageless = false, tocFontSize = 0): PageTocAnalysis {
  if (page.quality !== 'good') {
    return {
      hasTocHeading: false,
      tocHeadingLineIdx: -1,
      tocLineCount: 0,
      dotLeaderCount: 0,
      hasNonTocListHeading: false,
      pagelessTocCount: 0,
      pagelessEndLineIdx: -1,
      isPagelessBodyTransition: false,
    };
  }
  let hasTocHeading = false;
  let tocHeadingLineIdx = -1;
  let hasNonTocListHeading = false;
  let tocLineCount = 0;
  let dotLeaderCount = 0;

  const bodyLines = page.lines.filter((l) => !l.isHeaderFooter);
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const norm = normalizeUnicode(line.text);
    if (TOC_HEADING_RE.test(norm)) {
      if (!hasTocHeading) {
        hasTocHeading = true;
        tocHeadingLineIdx = i;
      }
    } else if (NON_TOC_LIST_HEADING_RE.test(norm)) {
      hasNonTocListHeading = true;
    }
    const extracted = extractEntryFromLine(line, page.width);
    if (extracted && !isTableOrFigureCaption(extracted.titlePart)) {
      tocLineCount++;
      if (extracted.viaDotLeader) dotLeaderCount++;
    }
  }

  // Phân tích khối Contents không có số trang (kiểu hyperlink-only như RFC v3 / HTML-to-PDF)
  let pagelessTocCount = 0;
  let pagelessEndLineIdx = -1;
  let isPagelessBodyTransition = false;

  const scanStart = hasTocHeading ? tocHeadingLineIdx + 1 : continuingPageless ? 0 : -1;
  if (scanStart >= 0 && scanStart < bodyLines.length) {
    let refFontSize = tocFontSize;
    let consecutiveNonToc = 0;
    for (let i = scanStart; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const norm = normalizeUnicode(line.text);
      if (!norm) continue;
      if (NON_TOC_LIST_HEADING_RE.test(norm)) {
        isPagelessBodyTransition = true;
        break;
      }
      // Nếu chuyển sang cỡ chữ lớn hơn rõ rệt (tiêu đề thân bài) khi đang trong khối TOC không số trang -> hết TOC
      if (refFontSize > 0 && line.fontSize >= refFontSize * 1.2 && pagelessTocCount >= 2) {
        isPagelessBodyTransition = true;
        break;
      }
      if (isPagelessTocEntryText(norm)) {
        pagelessTocCount++;
        pagelessEndLineIdx = i;
        consecutiveNonToc = 0;
        if (refFontSize === 0) refFontSize = line.fontSize;
      } else {
        // Cho phép dòng tiêu đề TOC xuống dòng ngắn (<= 75 ký tự, thụt lề hoặc không phải đoạn văn)
        const nextLine = i + 1 < bodyLines.length ? bodyLines[i + 1] : null;
        const looksWrappedTocTitle =
          pagelessTocCount > 0 &&
          norm.length <= 75 &&
          !/[.!?]$/.test(norm) &&
          nextLine !== null &&
          isPagelessTocEntryText(nextLine.text);
        if (looksWrappedTocTitle) {
          pagelessEndLineIdx = i;
          consecutiveNonToc = 0;
        } else {
          consecutiveNonToc++;
          if (consecutiveNonToc >= 2 || (pagelessTocCount > 0 && norm.length > 75)) {
            if (pagelessTocCount > 0) isPagelessBodyTransition = true;
            break;
          }
          if (pagelessTocCount === 0) break;
        }
      }
    }
  }

  return {
    hasTocHeading,
    tocHeadingLineIdx,
    tocLineCount,
    dotLeaderCount,
    hasNonTocListHeading,
    pagelessTocCount,
    pagelessEndLineIdx,
    isPagelessBodyTransition,
  };
}

/**
 * Đánh dấu cờ `isTocLine` trên từng dòng thuộc vùng Contents của các trang đã nhận diện.
 * Giúp `body_headings` loại bỏ chính xác cả trang Contents đầy đủ lẫn nửa đầu trang trộn Contents + thân bài.
 */
export function markTocLinesOnPages(
  pages: PageProfile[],
  tocPageNumbers: number[]
): { pagelessEntryCount: number; hasPageNumbers: boolean } {
  // Xóa cờ cũ nếu gọi lại
  for (const p of pages) {
    for (const l of p.lines) {
      l.isTocLine = false;
    }
  }
  if (tocPageNumbers.length === 0) {
    return { pagelessEntryCount: 0, hasPageNumbers: false };
  }

  let totalPaged = 0;
  for (const pn of tocPageNumbers) {
    const p = pages[pn - 1];
    if (!p || p.quality !== 'good') continue;
    totalPaged += analyzePageForToc(p).tocLineCount;
  }

  const hasPageNumbers = totalPaged >= 2;
  let pagelessEntryCount = 0;
  let refFontSize = 0;

  for (let idx = 0; idx < tocPageNumbers.length; idx++) {
    const pn = tocPageNumbers[idx];
    const page = pages[pn - 1];
    if (!page || page.quality !== 'good') continue;
    const bodyLines = page.lines.filter((l) => !l.isHeaderFooter);

    if (hasPageNumbers) {
      const analysis = analyzePageForToc(page);
      const startIdx = idx === 0 && analysis.tocHeadingLineIdx >= 0 ? analysis.tocHeadingLineIdx : 0;
      let lastTocIdx = -1;
      for (let i = startIdx; i < bodyLines.length; i++) {
        const norm = normalizeUnicode(bodyLines[i].text);
        if (NON_TOC_LIST_HEADING_RE.test(norm)) break;
        if (extractEntryFromLine(bodyLines[i], page.width) || TOC_HEADING_RE.test(norm)) {
          lastTocIdx = i;
        }
      }
      const endIdx = lastTocIdx >= startIdx ? lastTocIdx : bodyLines.length - 1;
      for (let i = startIdx; i <= endIdx; i++) {
        bodyLines[i].isTocLine = true;
      }
    } else {
      const analysis = analyzePageForToc(page, idx > 0, refFontSize);
      const startIdx = analysis.tocHeadingLineIdx >= 0 ? analysis.tocHeadingLineIdx : 0;
      if (analysis.pagelessEndLineIdx >= startIdx) {
        if (refFontSize === 0 && analysis.tocHeadingLineIdx + 1 < bodyLines.length) {
          refFontSize = bodyLines[analysis.tocHeadingLineIdx + 1].fontSize;
        }
        pagelessEntryCount += analysis.pagelessTocCount;
        for (let i = startIdx; i <= analysis.pagelessEndLineIdx; i++) {
          bodyLines[i].isTocLine = true;
        }
      }
    }
  }

  return { pagelessEntryCount, hasPageNumbers };
}

/**
 * Tìm dãy các trang Mục lục (ghép cả trường hợp Mục lục bị ngắt sang trang sau
 * và trường hợp Mục lục dạng hyperlink không in số trang như RFC v3).
 */
export function detectPrintedTocPages(pages: PageProfile[]): number[] {
  const totalPages = pages.length;
  if (totalPages === 0) return [];

  const frontScanLimit = Math.min(totalPages, Math.max(15, Math.ceil(totalPages * 0.35)));
  const candidateWindows: number[] = [];

  for (let i = 0; i < frontScanLimit; i++) {
    candidateWindows.push(i);
  }
  // Nhiều văn bản Việt Nam đặt Mục lục ở những trang cuối
  const backStart = Math.max(frontScanLimit, totalPages - 6);
  for (let i = backStart; i < totalPages; i++) {
    candidateWindows.push(i);
  }

  interface CandidateRun {
    pages: number[];
    tier: number;
    score: number;
  }

  let best: CandidateRun | null = null;

  const collectPagedRunFrom = (startIdx: number): number[] => {
    const run: number[] = [pages[startIdx].pageNumber];
    for (let j = startIdx + 1; j < Math.min(totalPages, startIdx + 18); j++) {
      const nextPage = pages[j];
      if (nextPage.quality !== 'good') break;
      const stats = analyzePageForToc(nextPage);
      if (stats.hasNonTocListHeading && stats.tocLineCount < 3) break;
      if (stats.hasTocHeading || stats.tocLineCount >= 2) {
        run.push(nextPage.pageNumber);
      } else {
        break;
      }
    }
    return run;
  };

  const collectPagelessRunFrom = (startIdx: number): { run: number[]; totalPageless: number } => {
    const firstPage = pages[startIdx];
    const firstStats = analyzePageForToc(firstPage, false, 0);
    const bodyLines = firstPage.lines.filter((l) => !l.isHeaderFooter);
    const refFontSize =
      firstStats.tocHeadingLineIdx >= 0 && firstStats.tocHeadingLineIdx + 1 < bodyLines.length
        ? bodyLines[firstStats.tocHeadingLineIdx + 1].fontSize
        : 0;

    const run: number[] = [firstPage.pageNumber];
    let totalPageless = firstStats.pagelessTocCount;
    if (firstStats.isPagelessBodyTransition) {
      return { run, totalPageless };
    }

    for (let j = startIdx + 1; j < Math.min(totalPages, startIdx + 12); j++) {
      const nextPage = pages[j];
      if (nextPage.quality !== 'good') break;
      const stats = analyzePageForToc(nextPage, true, refFontSize);
      if (stats.hasNonTocListHeading) break;
      if (stats.pagelessTocCount >= 3) {
        run.push(nextPage.pageNumber);
        totalPageless += stats.pagelessTocCount;
        if (stats.isPagelessBodyTransition) break;
      } else {
        break;
      }
    }
    return { run, totalPageless };
  };

  for (const idx of candidateWindows) {
    const page = pages[idx];
    const stats = analyzePageForToc(page);
    if (stats.hasNonTocListHeading && !stats.hasTocHeading) continue;

    // 1. Trường hợp Contents có số trang
    if (stats.hasTocHeading || stats.tocLineCount >= 5) {
      const run = collectPagedRunFrom(idx);
      let totalPaged = 0;
      let totalDots = 0;
      for (const pn of run) {
        const s = analyzePageForToc(pages[pn - 1]);
        totalPaged += s.tocLineCount;
        totalDots += s.dotLeaderCount;
      }

      if (totalPaged >= 2) {
        let tier = 0;
        if (stats.hasTocHeading && (totalDots >= 2 || totalPaged >= 3)) {
          tier = 3;
        } else if (!stats.hasTocHeading && totalDots >= 5) {
          tier = 2;
        } else if (!stats.hasTocHeading && totalPaged >= 5) {
          tier = 0;
        } else if (stats.hasTocHeading) {
          tier = 2;
        }
        const score = totalDots * 2 + totalPaged;
        if (!best || tier > best.tier || (tier === best.tier && score > best.score)) {
          best = { pages: run, tier, score };
        }
      }
    }

    // 2. Trường hợp Contents không in số trang (phải có tiêu đề Contents/Table of Contents/Mục lục rõ ràng)
    if (stats.hasTocHeading && stats.tocLineCount < 2 && stats.pagelessTocCount >= 4) {
      const { run, totalPageless } = collectPagelessRunFrom(idx);
      const tier = 1;
      const score = totalPageless;
      if (!best || tier > best.tier || (tier === best.tier && score > best.score)) {
        best = { pages: run, tier, score };
      }
    }
  }

  const bestPages = best?.pages ?? [];
  markTocLinesOnPages(pages, bestPages);
  return bestPages;
}

function isLikelyContinuationOfPrevious(
  prevEntryTitle: string,
  prevX: number,
  currentLine: PageLine,
  nextTocLine: PageLine | null
): boolean {
  const curText = normalizeUnicode(currentLine.text);
  if (!curText || STRUCTURAL_PREFIX_RE.test(curText)) return false;
  // Nếu dòng hiện tại là đầu của một tiêu đề lớn mới trước khi có số trang ở dòng dưới -> không ghép ngược
  if (nextTocLine) {
    const nextEntry = extractEntryFromLine(nextTocLine, 1000);
    if (nextEntry && !STRUCTURAL_PREFIX_RE.test(nextEntry.titlePart)) {
      // Dòng dưới không có prefix riêng -> dòng hiện tại nhiều khả năng là phần đầu của dòng dưới
      if (!/[,\-–:]$/.test(prevEntryTitle) && !/\b(?:and|or|of|for|with|in|the|và|của|cho|về|trong)$/i.test(prevEntryTitle)) {
        return false;
      }
    }
  }
  const prevEndsIncomplete =
    /[,\-–:/(]$/.test(prevEntryTitle) ||
    /\b(?:and|or|of|for|with|in|the|to|và|của|cho|về|trong|theo)$/i.test(prevEntryTitle);
  const isIndented = currentLine.x > prevX + 8;
  return prevEndsIncomplete || isIndented;
}

function parsePrintedTocLines(pages: PageProfile[], tocPageNumbers: number[]): ParsedTocEntry[] {
  const entries: ParsedTocEntry[] = [];
  let pendingLines: PageLine[] = [];

  for (const pn of tocPageNumbers) {
    const page = pages[pn - 1];
    if (!page || page.quality !== 'good') continue;

    const lines = page.lines.filter((l) => !l.isHeaderFooter);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = normalizeUnicode(line.text);
      if (!text) continue;

      if (TOC_HEADING_RE.test(text)) {
        pendingLines = [];
        continue;
      }
      if (NON_TOC_LIST_HEADING_RE.test(text)) {
        pendingLines = [];
        break;
      }
      // Bỏ dòng tiêu đề cột bảng mục lục như "Page", "Trang", "Contents Page", "Clause Title Page"
      if (TOC_COLUMN_HEADER_RE.test(text)) {
        pendingLines = [];
        continue;
      }

      const extracted = extractEntryFromLine(line, page.width);
      if (extracted) {
        let titleParts: string[] = [];
        let leftX = line.x;

        if (pendingLines.length > 0) {
          // Chỉ ghép các dòng pending không phải group heading độc lập (trừ khi dòng hiện tại không có prefix)
          const currentHasPrefix = STRUCTURAL_PREFIX_RE.test(extracted.titlePart);
          const filteredPending = pendingLines.filter((pl) => {
            const pText = normalizeUnicode(pl.text);
            if (!currentHasPrefix) return true;
            // Nếu dòng hiện tại đã có prefix (vd "1.2 ..."), tránh dính nhầm "Chương I" làm tiền tố của "Điều 1"
            if (/^(?:Phần|Chương|Mục|Part|Chapter)\b/i.test(pText) && !/^(?:Điều|Mục|\d)/i.test(pText)) {
              return false;
            }
            return true;
          });
          if (filteredPending.length > 0) {
            titleParts = filteredPending.map((p) => normalizeUnicode(p.text));
            leftX = Math.min(leftX, ...filteredPending.map((p) => p.x));
          }
          pendingLines = [];
        }

        titleParts.push(extracted.titlePart);
        const combinedRawTitle = titleParts.join(' ');
        const cleaned = cleanTocTitle(combinedRawTitle);
        const parsedPage = parsePageToken(extracted.pageToken);

        if (
          parsedPage &&
          !isJunkTitle(cleaned.title) &&
          !isTableOrFigureCaption(cleaned.title) &&
          !isVirtualFirstPageTitle(cleaned.title)
        ) {
          entries.push({
            title: cleaned.title,
            level: 1,
            printedPageRaw: extracted.pageToken,
            printedNumeric: parsedPage.numeric,
            pageKind: parsedPage.kind,
            prefixGroup: parsedPage.prefixGroup,
            leftX,
            tocPageNumber: pn,
            hasStructuralPrefix: STRUCTURAL_PREFIX_RE.test(cleaned.title),
          });
        }
      } else {
        // Dòng không có số trang: xét xem là phần đuôi của mục vừa đọc hay phần đầu của mục sắp tới
        const nextLineWithPage =
          lines.slice(i + 1, i + 4).find((l) => extractEntryFromLine(l, page.width) !== null) ?? null;

        if (
          pendingLines.length === 0 &&
          entries.length > 0 &&
          entries[entries.length - 1].tocPageNumber === pn &&
          isLikelyContinuationOfPrevious(
            entries[entries.length - 1].title,
            entries[entries.length - 1].leftX,
            line,
            nextLineWithPage
          )
        ) {
          const prev = entries[entries.length - 1];
          const merged = cleanTocTitle(`${prev.title} ${text}`).title;
          if (!isTableOrFigureCaption(merged)) {
            prev.title = merged;
          }
        } else {
          // Đưa vào buffer chờ dòng mang số trang phía dưới (tối đa 3 dòng)
          if (text.length <= 160) {
            pendingLines.push(line);
            if (pendingLines.length > 3) {
              pendingLines.shift();
            }
          } else {
            pendingLines = [];
          }
        }
      }
    }
    pendingLines = [];
  }

  // Suy luận level cho toàn bộ entries
  const hasPhan = entries.some((e) => /^Phần\s+/i.test(e.title));
  const hasChuong = entries.some((e) => /^Chương\s+/i.test(e.title));

  // Gom cụm leftX cho các dòng không có tiền tố phân cấp số
  const xClusters: number[] = [];
  for (const e of entries) {
    if (!xClusters.some((c) => Math.abs(c - e.leftX) <= 8)) {
      xClusters.push(e.leftX);
    }
  }
  xClusters.sort((a, b) => a - b);

  for (const e of entries) {
    const inferred = inferLevelFromTitle(e.title, hasPhan, hasChuong);
    if (inferred !== null) {
      e.level = inferred;
    } else {
      const idx = xClusters.findIndex((c) => Math.abs(c - e.leftX) <= 8);
      e.level = Math.min(6, Math.max(1, (idx >= 0 ? idx : 0) + 1));
    }
  }

  return entries;
}

function buildSearchPrefix(title: string): string | null {
  const m =
    /^(Phần\s+\S+|Chương\s+\S+|Mục\s+\S+|Điều\s+\d+[a-z]?|Phụ\s+lục\s+\S+|Chapter\s+\S+|Annex\s+[A-Z0-9]+|Appendix\s+[A-Z0-9]+|[A-Z]\.\d+(?:\.\d+)*|\d+(?:\.\d+)*)\b/i.exec(
      normalizeUnicode(title)
    );
  return m ? toComparisonKey(m[1]) : null;
}

function findEntryBodyPage(
  entry: ParsedTocEntry,
  pages: PageProfile[],
  tocPageSet: Set<number>,
  searchPages?: number[]
): { pageNumber: number; score: number } | null {
  const targetKey = toComparisonKey(entry.title);
  if (targetKey.length < 3) return null;
  const prefixKey = buildSearchPrefix(entry.title);

  let bestPage = -1;
  let bestScore = 0;

  const pageOrder = searchPages ?? pages.map((p) => p.pageNumber);
  for (const pn of pageOrder) {
    if (tocPageSet.has(pn)) continue;
    const page = pages[pn - 1];
    if (!page || page.quality !== 'good') continue;

    const bodyLines = page.lines.filter((l) => !l.isHeaderFooter && !l.isTocLine && !isMultiColumnTableRow(l));
    for (let i = 0; i < bodyLines.length; i++) {
      const l1 = bodyLines[i];
      const l2 = i + 1 < bodyLines.length ? bodyLines[i + 1] : null;
      const candidates = [
        { text: l1.text, line: l1 },
        ...(l2 && l1.y - l2.y <= l1.fontSize * 2.2
          ? [{ text: `${l1.text} ${l2.text}`, line: l1 }]
          : []),
      ];

      for (const cand of candidates) {
        const candKey = toComparisonKey(cand.text);
        if (!candKey) continue;

        let score = 0;
        const prefixMatchesStart = prefixKey !== null && candKey.startsWith(prefixKey);
        const overlap = tokenOverlapScore(entry.title, cand.text);

        if (candKey === targetKey) {
          score = 1.0;
        } else if (prefixMatchesStart && overlap >= 0.55) {
          score = 0.65 + 0.35 * overlap;
        } else if (overlap >= 0.72 && cand.text.length <= entry.title.length * 1.8 + 20) {
          score = overlap * 0.9;
        }

        if (score <= 0) continue;

        // Ưu tiên dòng có dáng dấp tiêu đề (đậm, căn giữa, ít chữ dư thừa)
        if (cand.line.isBold || cand.line.isCentered) score += 0.08;
        if (cand.line.text.length > entry.title.length * 2.2 + 30) score -= 0.15;

        if (score > bestScore) {
          bestScore = score;
          bestPage = pn;
        }
      }
    }
  }

  return bestPage > 0 && bestScore >= 0.7 ? { pageNumber: bestPage, score: bestScore } : null;
}

function selectRepresentativeAnchors(entries: ParsedTocEntry[], maxCount: number): ParsedTocEntry[] {
  const baseEligible = entries.filter((e) => toComparisonKey(e.title).length >= 5);
  // Ưu tiên mục có tiền tố cấu trúc rõ ràng (vd "1.1 ...", "Chương I ...", "Appendix A ...") để giảm trùng tên chung chung
  const structured = baseEligible.filter((e) => e.hasStructuralPrefix);
  const eligible = structured.length >= Math.min(maxCount, 6) ? structured : baseEligible;
  if (eligible.length <= maxCount) return eligible;
  const picked: ParsedTocEntry[] = [];
  const step = (eligible.length - 1) / (maxCount - 1);
  const seenIdx = new Set<number>();
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round(i * step);
    if (!seenIdx.has(idx)) {
      seenIdx.add(idx);
      picked.push(eligible[idx]);
    }
  }
  return picked;
}

function pickModeOffset(matches: PrintedTocAnchorMatch[]): number | null {
  if (matches.length === 0) return null;
  const counts = new Map<number, { count: number; scoreSum: number }>();
  for (const m of matches) {
    const cur = counts.get(m.offset) ?? { count: 0, scoreSum: 0 };
    cur.count++;
    cur.scoreSum += m.matchScore;
    counts.set(m.offset, cur);
  }
  let bestOffset = matches[0].offset;
  let bestCount = -1;
  let bestScore = -1;
  for (const [offset, stat] of counts.entries()) {
    if (stat.count > bestCount || (stat.count === bestCount && stat.scoreSum > bestScore)) {
      bestCount = stat.count;
      bestScore = stat.scoreSum;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/**
 * Tính offset ĐỘNG đa neo (hỗ trợ cả đánh số La Mã đầu sách và lệch offset phân đoạn).
 */
export function resolveDynamicOffsets(
  entries: ParsedTocEntry[],
  pages: PageProfile[],
  tocPages: number[]
): OffsetInfo {
  const tocPageSet = new Set(tocPages);
  const arabicEntries = entries.filter((e) => e.pageKind === 'arabic');
  const romanEntries = entries.filter((e) => e.pageKind === 'roman');

  const arabicAnchors = selectRepresentativeAnchors(arabicEntries, 18);
  const matchedArabic: PrintedTocAnchorMatch[] = [];

  for (const anchor of arabicAnchors) {
    const found = findEntryBodyPage(anchor, pages, tocPageSet);
    if (found) {
      matchedArabic.push({
        title: anchor.title,
        printedPage: anchor.printedPageRaw,
        printedNumeric: anchor.printedNumeric,
        kind: 'arabic',
        matchedPdfPage: found.pageNumber,
        offset: found.pageNumber - anchor.printedNumeric,
        matchScore: Math.round(found.score * 100) / 100,
      });
    }
  }

  matchedArabic.sort((a, b) => a.printedNumeric - b.printedNumeric);

  // Kiểm tra tính vật lý: nếu nhiều neo trải dài trên >= 4 trang in nhưng đều khớp dồn vào 1-2 trang PDF
  // (ví dụ khớp nhầm vào một bảng tổng hợp/checklist thay vì tiêu đề thân bài thật) -> từ chối offset giả!
  let collapsedTableMatch = false;
  if (matchedArabic.length >= 3) {
    const printedSpan =
      matchedArabic[matchedArabic.length - 1].printedNumeric - matchedArabic[0].printedNumeric;
    const matchedPages = matchedArabic.map((m) => m.matchedPdfPage);
    const pdfSpan = Math.max(...matchedPages) - Math.min(...matchedPages);
    if (printedSpan >= 4 && pdfSpan <= 1) {
      collapsedTableMatch = true;
    }
  }

  const primaryOffset = collapsedTableMatch ? null : pickModeOffset(matchedArabic);

  // Phát hiện offset phân đoạn (piecewise) nếu phần sau có >= 2 neo liên tiếp cùng lệch sang offset mới
  // và KHÔNG gây nhảy lùi trang vật lý so với đoạn trước đó.
  const piecewiseOffsets: Array<{ fromPrintedPage: number; offset: number; matchedCount: number }> = [];
  if (primaryOffset !== null && matchedArabic.length >= 4) {
    let prevOffset = primaryOffset;
    let prevPrinted = matchedArabic[0].printedNumeric;
    let i = 0;
    while (i < matchedArabic.length) {
      const off = matchedArabic[i].offset;
      if (off !== prevOffset) {
        let j = i;
        while (j + 1 < matchedArabic.length && matchedArabic[j + 1].offset === off) {
          j++;
        }
        const runLen = j - i + 1;
        const segStartPrinted = matchedArabic[i].printedNumeric;
        const prevEndPdf = (i > 0 ? matchedArabic[i - 1].printedNumeric : prevPrinted) + prevOffset;
        const segStartPdf = segStartPrinted + off;
        if (runLen >= 2 && segStartPdf >= prevEndPdf) {
          piecewiseOffsets.push({
            fromPrintedPage: segStartPrinted,
            offset: off,
            matchedCount: runLen,
          });
          prevOffset = off;
          prevPrinted = segStartPrinted;
        }
        i = j + 1;
      } else {
        prevPrinted = matchedArabic[i].printedNumeric;
        i++;
      }
    }
  }

  const effectiveArabicOffset = (printedNum: number): number | null => {
    if (primaryOffset === null) return null;
    let active = primaryOffset;
    for (const seg of piecewiseOffsets) {
      if (printedNum >= seg.fromPrintedPage) {
        active = seg.offset;
      }
    }
    return active;
  };

  let consistentArabic = 0;
  for (const m of matchedArabic) {
    if (m.offset === effectiveArabicOffset(m.printedNumeric)) {
      consistentArabic++;
    }
  }

  const arabicMatchRate = arabicAnchors.length > 0 ? matchedArabic.length / arabicAnchors.length : 0;
  const arabicConsistencyRate = matchedArabic.length > 0 ? consistentArabic / matchedArabic.length : 0;

  let confidence = 0;
  if (primaryOffset === null) {
    confidence = 0;
  } else if (matchedArabic.length >= 2) {
    confidence = clampConfidence(
      0.3 * Math.min(1, matchedArabic.length / 4) +
        0.35 * arabicMatchRate +
        0.35 * arabicConsistencyRate
    );
    if (matchedArabic.length >= 3 && arabicConsistencyRate < 0.5) {
      confidence = Math.min(confidence, 0.35);
    }
  } else if (matchedArabic.length === 1 && arabicAnchors.length <= 3) {
    confidence = clampConfidence(0.5 * matchedArabic[0].matchScore);
  } else if (matchedArabic.length === 1) {
    confidence = 0.35;
  }

  // Tính offset cho phần La Mã trên các trang trước trang bắt đầu đánh số Ả Rập
  const romanAnchors = selectRepresentativeAnchors(romanEntries, 6);
  const matchedRoman: PrintedTocAnchorMatch[] = [];
  const arabicStartPdfPage = primaryOffset !== null ? Math.max(1, 1 + primaryOffset) : pages.length + 1;
  const romanCandidatePages = pages
    .filter((p) => p.pageNumber < arabicStartPdfPage && !tocPageSet.has(p.pageNumber))
    .map((p) => p.pageNumber);

  for (const anchor of romanAnchors) {
    const found = findEntryBodyPage(anchor, pages, tocPageSet, romanCandidatePages);
    if (found) {
      matchedRoman.push({
        title: anchor.title,
        printedPage: anchor.printedPageRaw,
        printedNumeric: anchor.printedNumeric,
        kind: 'roman',
        matchedPdfPage: found.pageNumber,
        offset: found.pageNumber - anchor.printedNumeric,
        matchScore: Math.round(found.score * 100) / 100,
      });
    }
  }
  const romanOffset = pickModeOffset(matchedRoman);
  const romanConsistent =
    romanOffset !== null ? matchedRoman.filter((m) => m.offset === romanOffset).length : 0;
  const romanConfidence =
    matchedRoman.length > 0
      ? clampConfidence(
          (matchedRoman.length / Math.max(1, romanAnchors.length)) *
            (romanConsistent / matchedRoman.length)
        )
      : 0;

  return {
    primaryOffset,
    confidence,
    anchorsTested: arabicAnchors.length,
    anchorsMatched: matchedArabic.length,
    anchorsConsistent: consistentArabic,
    piecewiseOffsets,
    romanOffset,
    romanConfidence,
    samples: [...matchedRoman, ...matchedArabic],
  };
}

function resolvePrintedPageToPdf(
  entry: ParsedTocEntry,
  offset: OffsetInfo,
  prefixedOffsets: Map<string, number>,
  totalPages: number
): number | null {
  if (entry.pageKind === 'arabic') {
    if (offset.primaryOffset === null) return null;
    let active = offset.primaryOffset;
    for (const seg of offset.piecewiseOffsets) {
      if (entry.printedNumeric >= seg.fromPrintedPage) {
        active = seg.offset;
      }
    }
    const pagePdf = entry.printedNumeric + active;
    return pagePdf >= 1 && pagePdf <= totalPages ? pagePdf : null;
  }
  if (entry.pageKind === 'roman') {
    if (offset.romanOffset === null) return null;
    const pagePdf = entry.printedNumeric + offset.romanOffset;
    return pagePdf >= 1 && pagePdf <= totalPages ? pagePdf : null;
  }
  if (entry.pageKind === 'prefixed' && entry.prefixGroup) {
    const off = prefixedOffsets.get(entry.prefixGroup);
    if (off === undefined) return null;
    const pagePdf = entry.printedNumeric + off;
    return pagePdf >= 1 && pagePdf <= totalPages ? pagePdf : null;
  }
  return null;
}

/**
 * Trích mục lục từ các trang Contents/Mục lục in và ánh xạ về `page_pdf` qua offset động.
 */
export function extractPrintedToc(
  pages: PageProfile[],
  preDetectedTocPages?: number[]
): PrintedTocResult {
  const totalPages = pages.length;
  const tocPages = preDetectedTocPages ?? detectPrintedTocPages(pages);
  if (tocPages.length === 0) {
    return {
      tocPages: [],
      rawEntriesCount: 0,
      pagelessEntriesCount: 0,
      hasPageNumbers: false,
      nodes: [],
      offset: {
        primaryOffset: null,
        confidence: 0,
        anchorsTested: 0,
        anchorsMatched: 0,
        anchorsConsistent: 0,
        piecewiseOffsets: [],
        romanOffset: null,
        romanConfidence: 0,
        samples: [],
      },
      suspiciousNodes: [],
      isUsable: false,
      failureReason: 'no_printed_toc_pages',
    };
  }

  const tocMeta = markTocLinesOnPages(pages, tocPages);
  const entries = parsePrintedTocLines(pages, tocPages);
  if (entries.length < 2) {
    return {
      tocPages,
      rawEntriesCount: entries.length,
      pagelessEntriesCount: tocMeta.pagelessEntryCount,
      hasPageNumbers: tocMeta.hasPageNumbers,
      nodes: [],
      offset: {
        primaryOffset: null,
        confidence: 0,
        anchorsTested: 0,
        anchorsMatched: 0,
        anchorsConsistent: 0,
        piecewiseOffsets: [],
        romanOffset: null,
        romanConfidence: 0,
        samples: [],
      },
      suspiciousNodes: [],
      isUsable: false,
      failureReason:
        tocMeta.pagelessEntryCount >= 4 ? 'pageless_toc_no_page_numbers' : 'too_few_toc_entries',
    };
  }

  const offset = resolveDynamicOffsets(entries, pages, tocPages);

  // Tính riêng offset cho các trang đánh số kiểu Phụ lục "A-1", "B-1" nếu có
  const prefixedOffsets = new Map<string, number>();
  const tocPageSet = new Set(tocPages);
  const groups = new Set(entries.filter((e) => e.prefixGroup).map((e) => e.prefixGroup!));
  for (const grp of groups) {
    const grpAnchors = entries.filter((e) => e.prefixGroup === grp).slice(0, 3);
    const diffs: number[] = [];
    for (const a of grpAnchors) {
      const found = findEntryBodyPage(a, pages, tocPageSet);
      if (found) diffs.push(found.pageNumber - a.printedNumeric);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      prefixedOffsets.set(grp, diffs[Math.floor(diffs.length / 2)]);
    }
  }

  const hasReliableOffset =
    offset.primaryOffset !== null &&
    (offset.confidence >= 0.45 || (offset.anchorsMatched >= 1 && entries.length <= 5));

  if (!hasReliableOffset) {
    return {
      tocPages,
      rawEntriesCount: entries.length,
      nodes: [],
      offset,
      suspiciousNodes: [],
      isUsable: false,
      failureReason: `unverified_offset(matched=${offset.anchorsMatched}/${offset.anchorsTested},conf=${offset.confidence})`,
    };
  }

  const nodes: TocNode[] = [];
  const suspiciousNodes: SuspiciousNode[] = [];

  for (const entry of entries) {
    const pagePdf = resolvePrintedPageToPdf(entry, offset, prefixedOffsets, totalPages);
    if (pagePdf === null) {
      suspiciousNodes.push({
        title: entry.title,
        page_pdf: Math.max(1, Math.min(totalPages, entry.printedNumeric + (offset.primaryOffset ?? 0))),
        level: entry.level,
        source: 'printed_toc',
        reason: `out_of_bounds_or_unmapped_page(${entry.printedPageRaw})`,
      });
      continue;
    }

    const nodeConfidence = clampConfidence(
      entry.pageKind === 'roman'
        ? Math.max(0.5, offset.romanConfidence * 0.9)
        : 0.55 + 0.4 * offset.confidence
    );

    nodes.push({
      title: entry.title,
      level: entry.level,
      page_pdf: pagePdf,
      sort: nodes.length + 1,
      source: 'printed_toc',
      confidence: nodeConfidence,
    });
  }

  // Kiểm tra nhảy lùi trang bất thường trong mục lục in
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].page_pdf < nodes[i - 1].page_pdf) {
      suspiciousNodes.push({
        title: nodes[i].title,
        page_pdf: nodes[i].page_pdf,
        level: nodes[i].level,
        source: 'printed_toc',
        reason: `page_regressed_from_${nodes[i - 1].page_pdf}`,
      });
    }
  }

  return {
    tocPages,
    rawEntriesCount: entries.length,
    pagelessEntriesCount: tocMeta.pagelessEntryCount,
    hasPageNumbers: true,
    nodes,
    offset,
    suspiciousNodes,
    isUsable: nodes.length >= 2,
  };
}
