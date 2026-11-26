import { normalizeUnicode, stripTrailingFootnoteMarker } from './normalize.js';
import type { PageLine, TextRun } from './types.js';

export interface BuildLinesOptions {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  runs: TextRun[];
}

const SUPERSCRIPT_TOKEN_RE = /^(?:\d{1,2}|[*†‡§*]|\[\d{1,2}\]|\(\d{1,2}\))$/;
const TRAILING_PAGE_RE = /^(.+?)\s+([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})$/i;
const DOT_LEADER_RE = /(?:\.{2,}|…+|(?:\.\s+){2,}|_{3,}|-{4,})/;

function medianWeightedFontSize(runs: TextRun[]): number {
  const weighted: Array<{ size: number; weight: number }> = [];
  let totalWeight = 0;
  for (const r of runs) {
    const w = r.text.replace(/\s+/g, '').length;
    if (w <= 0 || !Number.isFinite(r.fontSize) || r.fontSize <= 0) continue;
    weighted.push({ size: r.fontSize, weight: w });
    totalWeight += w;
  }
  if (weighted.length === 0) return 10;
  weighted.sort((a, b) => a.size - b.size);
  let acc = 0;
  for (const item of weighted) {
    acc += item.weight;
    if (acc >= totalWeight / 2) return item.size;
  }
  return weighted[weighted.length - 1].size;
}

function isSuperscriptFootnoteRun(
  run: TextRun,
  index: number,
  sortedRuns: TextRun[],
  dominantFontSize: number,
  baselineY: number
): boolean {
  const trimmed = normalizeUnicode(run.text);
  if (!trimmed || !SUPERSCRIPT_TOKEN_RE.test(trimmed)) return false;
  if (run.fontSize >= dominantFontSize * 0.82) return false;
  if (run.y <= baselineY + dominantFontSize * 0.16) return false;
  // Chỉ loại khi nằm sau token chữ/dấu kết thúc (chú thích cuối tiêu đề/câu), không phải số mục đầu dòng
  if (index === 0) return false;
  const prevText = normalizeUnicode(sortedRuns[index - 1].text);
  if (!/[\p{L})”’".,;:]/u.test(prevText)) return false;
  const gap = run.x - sortedRuns[index - 1].xEnd;
  if (gap > dominantFontSize * 1.8) return false;
  return true;
}

function assembleLineText(
  runs: TextRun[],
  dominantFontSize: number,
  baselineY: number
): {
  text: string;
  rawText: string;
  hadSuperscriptStripped: boolean;
  trailingPageToken: string | null;
  trailingPageGap: number;
  x: number;
  xEnd: number;
} {
  const sorted = [...runs].sort((a, b) => a.x - b.x);
  const kept: TextRun[] = [];
  let rawText = '';
  let hadSuperscriptStripped = false;

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (rawText.length > 0 && i > 0) {
      const gapRaw = r.x - sorted[i - 1].xEnd;
      if (gapRaw > Math.max(1.2, r.fontSize * 0.16)) {
        rawText += ' ';
      }
    }
    rawText += r.text;

    if (isSuperscriptFootnoteRun(r, i, sorted, dominantFontSize, baselineY)) {
      hadSuperscriptStripped = true;
      continue;
    }
    kept.push(r);
  }

  let text = '';
  let lastKept: TextRun | null = null;
  let lastGap = 0;

  for (const r of kept) {
    if (!r.text) continue;
    if (lastKept) {
      const gap = r.x - lastKept.xEnd;
      if (gap > Math.max(1.2, Math.min(r.fontSize, lastKept.fontSize) * 0.16)) {
        if (!text.endsWith(' ') && !r.text.startsWith(' ')) {
          text += ' ';
        }
        lastGap = gap;
      } else {
        lastGap = 0;
      }
    }
    text += r.text;
    lastKept = r;
  }

  let normText = normalizeUnicode(text);
  const rawNorm = normalizeUnicode(rawText);

  // Kiểm tra trailing page token + khoảng hở với run có chữ liền trước (bỏ qua run chỉ chứa khoảng trắng)
  let trailingPageToken: string | null = null;
  let trailingPageGap = 0;

  const nonSpaceKept = kept.filter((r) => normalizeUnicode(r.text).length > 0);
  if (nonSpaceKept.length >= 2) {
    const last = nonSpaceKept[nonSpaceKept.length - 1];
    const lastNorm = normalizeUnicode(last.text);
    const prev = nonSpaceKept[nonSpaceKept.length - 2];
    const gapToLast = last.x - prev.xEnd;
    if (/^(?:[ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})$/i.test(lastNorm)) {
      if (gapToLast >= -0.5) {
        trailingPageToken = lastNorm;
        trailingPageGap = Math.max(0, gapToLast);
      }
    } else {
      const dotGlued = /(?:\.{2,}|…+)\s*([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})$/i.exec(lastNorm);
      if (dotGlued) {
        trailingPageToken = dotGlued[1];
        trailingPageGap = Math.max(0, gapToLast);
      }
    }
  }
  if (!trailingPageToken) {
    const m = TRAILING_PAGE_RE.exec(normText);
    if (m) {
      trailingPageToken = m[2];
      trailingPageGap = lastGap;
    } else {
      const dotGlued = /(?:\.{2,}|…+)\s*([ivxlcdm]{1,7}|[A-Z]-\d{1,4}|\d{1,4})$/i.exec(normText);
      if (dotGlued) {
        trailingPageToken = dotGlued[1];
        trailingPageGap = 0;
      }
    }
  }

  // Nếu tiêu đề không có chấm dẫn hay khoảng hở số trang (không phải TOC entry),
  // áp dụng fallback bỏ chỉ số trên dính sát nếu nằm ở cuối dòng chữ
  if (!DOT_LEADER_RE.test(normText) && trailingPageGap < 20) {
    const fallback = stripTrailingFootnoteMarker(normText);
    if (fallback.stripped) {
      normText = fallback.text;
      hadSuperscriptStripped = true;
    }
  }

  const minX = kept.length > 0 ? Math.min(...kept.map((r) => r.x)) : sorted[0]?.x ?? 0;
  const maxXEnd = kept.length > 0 ? Math.max(...kept.map((r) => r.xEnd)) : sorted[sorted.length - 1]?.xEnd ?? 0;

  return {
    text: normText,
    rawText: rawNorm,
    hadSuperscriptStripped,
    trailingPageToken,
    trailingPageGap,
    x: minX,
    xEnd: maxXEnd,
  };
}

/**
 * Phát hiện dòng dạng bảng nhiều cột dựa trên khoảng trống thực giữa các run không-rỗng
 * (bỏ qua run chỉ gồm khoảng trắng vốn hay được Word/PDF sinh ra để lấp khoảng giữa các cột).
 */
export function isMultiColumnTableRow(line: PageLine): boolean {
  const nonSpaceRuns = line.runs.filter((r) => normalizeUnicode(r.text).length > 0);
  if (nonSpaceRuns.length < 3) return false;
  let wideGaps = 0;
  let veryWideGaps = 0;
  const threshold = Math.max(14, line.fontSize * 2.2);
  const veryWideThreshold = Math.max(36, line.fontSize * 3.8);
  for (let i = 1; i < nonSpaceRuns.length; i++) {
    const gap = nonSpaceRuns[i].x - nonSpaceRuns[i - 1].xEnd;
    if (gap > threshold) wideGaps++;
    if (gap > veryWideThreshold) veryWideGaps++;
  }
  return wideGaps >= 3 || veryWideGaps >= 2;
}

/**
 * Phát hiện trang bố cục hai cột dựa trên rãnh trống ở vùng giữa trang (42%..58% chiều rộng).
 */
export function detectMultiColumnPage(lines: PageLine[], pageWidth: number): boolean {
  if (pageWidth <= 0 || lines.length < 14) return false;
  const gutterLeft = pageWidth * 0.42;
  const gutterRight = pageWidth * 0.58;
  let leftColCount = 0;
  let rightColCount = 0;
  let crossingLines = 0;

  for (const line of lines) {
    if (line.isHeaderFooter) continue;
    const trimmed = line.text.trim();
    if (trimmed.length < 6) continue;
    if (line.xEnd <= gutterLeft + 8) {
      leftColCount++;
    } else if (line.x >= gutterRight - 8) {
      rightColCount++;
    } else if (line.x < gutterLeft && line.xEnd > gutterRight) {
      // Kiểm tra xem dòng này có thực sự chứa chữ bắc qua rãnh hay là 2 đoạn trái-phải bị gom chung dòng
      const hasSplitRun = line.runs.some((r, idx) => {
        if (idx === 0) return false;
        const prev = line.runs[idx - 1];
        return prev.xEnd <= gutterLeft + 10 && r.x >= gutterRight - 10;
      });
      if (hasSplitRun) {
        leftColCount++;
        rightColCount++;
      } else {
        crossingLines++;
      }
    }
  }

  return leftColCount >= 8 && rightColCount >= 8 && crossingLines <= Math.max(4, (leftColCount + rightColCount) * 0.25);
}

/**
 * Gom các TextRun cùng y thành từng PageLine hoàn chỉnh trên một trang.
 */
export function buildPageLines(opts: BuildLinesOptions): {
  lines: PageLine[];
  isMultiColumn: boolean;
} {
  const { pageNumber, pageWidth, runs } = opts;
  const nonEmptyRuns = runs.filter((r) => normalizeUnicode(r.text).length > 0 || r.text === ' ');
  if (nonEmptyRuns.length === 0) {
    return { lines: [], isMultiColumn: false };
  }

  // Sắp từ trên xuống dưới (y giảm dần trong hệ tọa độ PDF), sau đó từ trái sang phải
  const sortedByY = [...nonEmptyRuns].sort((a, b) => {
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1.5) return dy;
    return a.x - b.x;
  });

  interface Cluster {
    anchorY: number;
    anchorSize: number;
    runs: TextRun[];
  }

  const clusters: Cluster[] = [];
  for (const r of sortedByY) {
    const rSize = r.fontSize > 0 ? r.fontSize : 10;
    let target: Cluster | null = null;

    // Ưu tiên khớp cluster gần nhất trong ngưỡng y tolerance
    for (let i = clusters.length - 1; i >= Math.max(0, clusters.length - 8); i--) {
      const c = clusters[i];
      const baseSize = Math.max(c.anchorSize, rSize);
      const tol = Math.max(2.5, baseSize * 0.48);
      if (Math.abs(r.y - c.anchorY) <= tol) {
        target = c;
        break;
      }
    }

    if (target) {
      target.runs.push(r);
      // Cập nhật anchorY bằng chữ kích thước chính (không bị kéo theo superscript nhỏ)
      if (rSize >= target.anchorSize * 0.85) {
        const wTotal = target.runs.filter((x) => x.fontSize >= target.anchorSize * 0.85).length;
        target.anchorY = (target.anchorY * (wTotal - 1) + r.y) / wTotal;
        if (rSize > target.anchorSize) target.anchorSize = rSize;
      }
    } else {
      clusters.push({ anchorY: r.y, anchorSize: rSize, runs: [r] });
    }
  }

  const lines: PageLine[] = [];
  for (const cluster of clusters) {
    const dominantFontSize = medianWeightedFontSize(cluster.runs);
    const baselineY = cluster.anchorY;
    const assembled = assembleLineText(cluster.runs, dominantFontSize, baselineY);
    if (!assembled.text) continue;

    // Tính bold/italic theo trọng số ký tự
    let boldWeight = 0;
    let italicWeight = 0;
    let totalWeight = 0;
    for (const r of cluster.runs) {
      const w = r.text.replace(/\s+/g, '').length;
      if (w <= 0) continue;
      totalWeight += w;
      if (r.isBold) boldWeight += w;
      if (r.isItalic) italicWeight += w;
    }

    const isBold = totalWeight > 0 && boldWeight / totalWeight >= 0.55;
    const isItalic = totalWeight > 0 && italicWeight / totalWeight >= 0.55;
    const lettersOnly = assembled.text.replace(/[^\p{L}]/gu, '');
    const isAllCaps =
      lettersOnly.length >= 2 &&
      lettersOnly === lettersOnly.toUpperCase() &&
      lettersOnly !== lettersOnly.toLowerCase();

    const lineWidth = Math.max(0, assembled.xEnd - assembled.x);
    const center = (assembled.x + assembled.xEnd) / 2;
    const isCentered =
      pageWidth > 0 &&
      lineWidth < pageWidth * 0.78 &&
      Math.abs(center - pageWidth / 2) <= pageWidth * 0.08 &&
      assembled.x >= pageWidth * 0.12;

    const hasDotLeader = DOT_LEADER_RE.test(assembled.text);

    lines.push({
      pageNumber,
      text: assembled.text,
      rawText: assembled.rawText,
      normalizedText: assembled.text,
      x: assembled.x,
      xEnd: assembled.xEnd,
      y: baselineY,
      width: lineWidth,
      fontSize: Math.round(dominantFontSize * 100) / 100,
      isBold,
      isItalic,
      isAllCaps,
      isCentered,
      hasDotLeader,
      trailingPageToken: assembled.trailingPageToken,
      trailingPageGap: assembled.trailingPageGap,
      isHeaderFooter: false,
      isLicenseOrWatermark: false,
      isTocLine: false,
      hadSuperscriptStripped: assembled.hadSuperscriptStripped,
      runs: [...cluster.runs].sort((a, b) => a.x - b.x),
    });
  }

  lines.sort((a, b) => b.y - a.y);
  const isMultiColumn = detectMultiColumnPage(lines, pageWidth);
  return { lines, isMultiColumn };
}
