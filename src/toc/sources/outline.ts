import {
  clampConfidence,
  cleanTocTitle,
  isJunkTitle,
  isTableOrFigureCaption,
  isVirtualFirstPageTitle,
  normalizeUnicode,
} from '../normalize.js';
import type { OutlineEvaluation, PageProfile, RawOutlineEntry, TocNode } from '../types.js';

const AUTO_GENERATED_OUTLINE_LABEL_RE =
  /^(?:(?:page|trang|p|pg|img|image|scan|slide|sheet|bookmark|item|doc|file)[\s._\-:#]*0*\d+|0{2,}\d+)$/i;

const STRUCTURAL_SKELETON_PREFIX_RE =
  /^(?:phần|chương|mục|tiểu\s+mục|điều|phụ\s+lục|chapter|part|section|clause|article|annex|appendix)\b/i;

/**
 * Phân loại tiêu đề rác trong outline (chỉ toàn số, không có chữ cái, quá ngắn, nhãn trang tự sinh).
 */
export function classifyOutlineTitleJunk(rawTitle: string): string | null {
  const norm = normalizeUnicode(rawTitle);
  if (!norm || isJunkTitle(norm)) return 'junk_title';

  const compact = norm.replace(/\s+/g, '');
  if (compact.length < 2) return 'too_short';

  // Không có chữ cái nào (vd "00000001", "123", "1.2", "---")
  const letterCount = norm.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount === 0) return 'digits_or_no_letters';

  // Quá ngắn và chỉ có 1 chữ cái (vd "a", "B1" không đủ nghĩa tiêu đề trừ khi là mục hợp lệ dài hơn)
  if (compact.length <= 2 && letterCount <= 1) return 'too_short';

  // Nhãn tự sinh từ máy scan/converter kiểu "00000001", "Page 12", "IMG_003", "Scan-04"
  if (AUTO_GENERATED_OUTLINE_LABEL_RE.test(norm)) return 'auto_generated_label';

  return null;
}

/**
 * Chuẩn hóa, làm sạch và đánh giá độ phủ + chất lượng tiêu đề của Outline (bookmark) có sẵn trong PDF.
 */
export function evaluateOutline(
  rawEntries: RawOutlineEntry[],
  totalPages: number,
  pages: PageProfile[]
): OutlineEvaluation {
  if (rawEntries.length === 0 || totalPages <= 0) {
    return {
      nodes: [],
      rawCount: 0,
      rawMaxDepth: 0,
      filteredOut: [],
      validRatio: 0,
      junkTitleRatio: 0,
      monotonicRatio: 0,
      minPageCovered: 0,
      maxPageCovered: 0,
      pageSpanRatio: 0,
      samePageBurstRatio: 0,
      isUsable: false,
      isPartial: false,
      partialReasons: [],
    };
  }

  let rawMaxDepth = 0;
  let junkCount = 0;
  const filteredOut: Array<{ title: string; reason: string; pagePdf: number | null }> = [];
  const validCandidates: Array<{ title: string; level: number; pagePdf: number }> = [];
  const skeletonCounts = new Map<string, number>();

  for (const entry of rawEntries) {
    if (entry.level > rawMaxDepth) rawMaxDepth = entry.level;

    const skel = normalizeUnicode(entry.title).toLowerCase().replace(/\d+/g, '#').trim();
    if (skel) {
      skeletonCounts.set(skel, (skeletonCounts.get(skel) ?? 0) + 1);
    }

    if (entry.pagePdf === null || !Number.isInteger(entry.pagePdf) || entry.pagePdf < 1 || entry.pagePdf > totalPages) {
      filteredOut.push({
        title: entry.title,
        reason: 'invalid_or_missing_page',
        pagePdf: entry.pagePdf,
      });
      continue;
    }

    const cleaned = cleanTocTitle(entry.title);
    const junkReason = classifyOutlineTitleJunk(cleaned.title);
    if (junkReason) {
      junkCount++;
      filteredOut.push({
        title: entry.title,
        reason: junkReason,
        pagePdf: entry.pagePdf,
      });
      continue;
    }

    if (entry.pagePdf === 1 && isVirtualFirstPageTitle(cleaned.title)) {
      filteredOut.push({
        title: entry.title,
        reason: 'virtual_first_page',
        pagePdf: entry.pagePdf,
      });
      continue;
    }

    if (isTableOrFigureCaption(cleaned.title)) {
      filteredOut.push({
        title: entry.title,
        reason: 'table_or_figure_caption',
        pagePdf: entry.pagePdf,
      });
      continue;
    }

    validCandidates.push({
      title: cleaned.title,
      level: Math.max(1, entry.level),
      pagePdf: entry.pagePdf,
    });
  }

  const junkTitleRatio = Math.round((junkCount / rawEntries.length) * 1000) / 1000;

  // Kiểm tra mẫu lặp tự sinh kiểu "0000000N", "Scan_N", "IMG_N" phủ >= 60% outline
  let topSkeleton = '';
  let topSkeletonCount = 0;
  for (const [skel, cnt] of skeletonCounts.entries()) {
    if (cnt > topSkeletonCount) {
      topSkeletonCount = cnt;
      topSkeleton = skel;
    }
  }
  const topSkeletonRatio = topSkeletonCount / rawEntries.length;
  const isRepetitiveJunkPattern =
    rawEntries.length >= 5 &&
    topSkeletonRatio >= 0.6 &&
    !STRUCTURAL_SKELETON_PREFIX_RE.test(topSkeleton);

  if (validCandidates.length === 0 || junkTitleRatio >= 0.4 || isRepetitiveJunkPattern) {
    const rejectedReason = isRepetitiveJunkPattern
      ? `repetitive_junk_pattern("${topSkeleton}",${topSkeletonCount}/${rawEntries.length})`
      : junkTitleRatio >= 0.4
        ? `high_junk_title_ratio(${junkCount}/${rawEntries.length})`
        : 'no_valid_outline_entries';
    return {
      nodes: [],
      rawCount: rawEntries.length,
      rawMaxDepth,
      filteredOut,
      validRatio: 0,
      junkTitleRatio,
      monotonicRatio: 0,
      minPageCovered: 0,
      maxPageCovered: 0,
      pageSpanRatio: 0,
      samePageBurstRatio: 0,
      isUsable: false,
      isPartial: false,
      partialReasons: [],
      rejectedReason,
    };
  }

  // Chuẩn hóa level bắt đầu từ 1 (trường hợp root bị lọc hết)
  const minLevel = Math.min(...validCandidates.map((c) => c.level));
  const levelShift = minLevel > 1 ? minLevel - 1 : 0;

  let monotonicOk = 1;
  const pageCounts = new Map<number, number>();
  let minPage = validCandidates[0].pagePdf;
  let maxPage = validCandidates[0].pagePdf;

  for (let i = 0; i < validCandidates.length; i++) {
    const p = validCandidates[i].pagePdf;
    pageCounts.set(p, (pageCounts.get(p) ?? 0) + 1);
    if (p < minPage) minPage = p;
    if (p > maxPage) maxPage = p;
    if (i > 0 && p >= validCandidates[i - 1].pagePdf) {
      monotonicOk++;
    }
  }

  const validRatio = validCandidates.length / rawEntries.length;
  const monotonicRatio = monotonicOk / validCandidates.length;
  const maxSamePage = Math.max(...pageCounts.values());
  const samePageBurstRatio = maxSamePage / validCandidates.length;
  const pageSpanRatio = (maxPage - minPage + 1) / totalPages;

  const isBrokenBurst = validCandidates.length >= 5 && samePageBurstRatio > 0.65;
  const minRequired = totalPages <= 3 ? 1 : 2;
  const isUsable =
    validCandidates.length >= minRequired &&
    validRatio >= 0.35 &&
    monotonicRatio >= 0.7 &&
    !isBrokenBurst;

  const goodPages = pages.filter((p) => p.quality === 'good').map((p) => p.pageNumber);
  const totalGoodPages = goodPages.length;
  const goodPagesBeforeMin = goodPages.filter((pn) => pn < minPage).length;
  const goodPagesAfterMax = goodPages.filter((pn) => pn > maxPage).length;

  const effectiveRefPages = totalGoodPages >= 10 ? totalGoodPages : totalPages;
  const pagesBeforeMin = totalGoodPages >= 10 ? goodPagesBeforeMin : Math.max(0, minPage - 1);
  const pagesAfterMax = totalGoodPages >= 10 ? goodPagesAfterMax : Math.max(0, totalPages - maxPage);

  const partialReasons: string[] = [];
  if (isUsable && effectiveRefPages >= 10) {
    // Hổng đầu: outline bỏ qua một phần lớn đầu tài liệu (ví dụ chỉ bắt đầu từ Phụ lục)
    if (pagesBeforeMin > Math.max(10, Math.ceil(effectiveRefPages * 0.2))) {
      partialReasons.push(
        `head_uncovered(${pagesBeforeMin}/${effectiveRefPages}_pages_before_p${minPage})`
      );
    }
    // Hổng đuôi: outline dừng sớm trước khi hết tài liệu
    if (pagesAfterMax > Math.max(8, Math.ceil(effectiveRefPages * 0.2))) {
      partialReasons.push(
        `tail_uncovered(${pagesAfterMax}/${effectiveRefPages}_pages_after_p${maxPage})`
      );
    }
    // Hổng giữa: khoảng trống lớn giữa 2 mốc outline liên tiếp (tính theo trang đã sắp tăng dần)
    const sortedPages = validCandidates.map((c) => c.pagePdf).sort((a, b) => a - b);
    let maxGap = 0;
    let gapPages: [number, number] = [0, 0];
    for (let i = 1; i < sortedPages.length; i++) {
      const gap = sortedPages[i] - sortedPages[i - 1];
      if (gap > maxGap) {
        maxGap = gap;
        gapPages = [sortedPages[i - 1], sortedPages[i]];
      }
    }
    if (
      (maxGap > Math.max(20, Math.ceil(totalPages * 0.35)) && validCandidates.length < 15) ||
      maxGap > Math.max(30, Math.ceil(totalPages * 0.4))
    ) {
      partialReasons.push(`large_internal_gap(p${gapPages[0]}->p${gapPages[1]})`);
    }
    // Khoảng phủ trang quá hẹp so với tổng số trang tài liệu
    if (totalPages >= 15 && pageSpanRatio < 0.45) {
      partialReasons.push(`low_page_span(${(pageSpanRatio * 100).toFixed(1)}%)`);
    }
  }

  const isPartial = partialReasons.length > 0;
  const baseConfidence = clampConfidence(
    0.72 + 0.15 * monotonicRatio + 0.08 * validRatio - (isPartial ? 0.06 : 0)
  );

  const nodes: TocNode[] = validCandidates.map((c, idx) => ({
    title: c.title,
    level: Math.max(1, c.level - levelShift),
    page_pdf: c.pagePdf,
    sort: idx + 1,
    source: 'outline',
    confidence: baseConfidence,
  }));

  return {
    nodes,
    rawCount: rawEntries.length,
    rawMaxDepth,
    filteredOut,
    validRatio,
    junkTitleRatio,
    monotonicRatio,
    minPageCovered: minPage,
    maxPageCovered: maxPage,
    pageSpanRatio,
    samePageBurstRatio,
    isUsable,
    isPartial,
    partialReasons,
  };
}
