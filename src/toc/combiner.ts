import {
  clampConfidence,
  getComparisonTokens,
  normalizeUnicode,
  toComparisonKey,
  tokenOverlapScore,
} from './normalize.js';
import type {
  CrossCheckSummary,
  OutlineEvaluation,
  PageProfile,
  PrintedTocResult,
  SuspiciousNode,
  TocLimits,
  TocNode,
  TocSource,
  TocStatus,
} from './types.js';
import { DEFAULT_TOC_LIMITS } from './types.js';

const ENGLISH_WORD_NUMBERS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

function normalizeRomanOrWordIndex(raw: string): string {
  const low = raw.trim().toLowerCase();
  if (ENGLISH_WORD_NUMBERS[low]) return ENGLISH_WORD_NUMBERS[low];
  if (/^\d+$/.test(low)) return String(Number.parseInt(low, 10));
  if (/^[ivxlcdm]+$/.test(low)) {
    const vals: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let total = 0;
    let prev = 0;
    for (let i = low.length - 1; i >= 0; i--) {
      const v = vals[low[i]] ?? 0;
      if (v < prev) total -= v;
      else {
        total += v;
        prev = v;
      }
    }
    if (total > 0 && total <= 100) return String(total);
  }
  return low;
}

/**
 * Trích tiền tố số hiệu cấu trúc đầu tiêu đề (vd "5.6.1" -> "num:5.6.1", "A.1" -> "num:a.1",
 * "Điều 5" -> "dieu:5", "Annex B" -> "annex:b") để chặn ghép nhầm giữa hai mục trùng tên chung như "General".
 */
export function extractStructuredPrefix(title: string): string | null {
  const norm = normalizeUnicode(title).trim();
  if (!norm) return null;

  let m = /^Phần\s+(?:thứ\s+)?([IVXLCDM]+|\d+|nhất|hai|ba|tư|năm)\b/i.exec(norm);
  if (m) return `phan:${normalizeRomanOrWordIndex(m[1])}`;

  m = /^Chương\s+([IVXLCDM]+|\d+)\b/i.exec(norm);
  if (m) return `chuong:${normalizeRomanOrWordIndex(m[1])}`;

  m = /^Mục\s+([IVXLCDM]+|\d+)\b/i.exec(norm);
  if (m) return `muc:${normalizeRomanOrWordIndex(m[1])}`;

  m = /^Tiểu\s+mục\s+([IVXLCDM]+|\d+)\b/i.exec(norm);
  if (m) return `tieumuc:${normalizeRomanOrWordIndex(m[1])}`;

  m = /^Điều\s+(\d+[a-z]?)\b/i.exec(norm);
  if (m) return `dieu:${m[1].toLowerCase()}`;

  m = /^Phụ\s+lục\s+([IVXLCDM]+|[A-Z0-9]+)\b/i.exec(norm);
  if (m) return `phuluc:${m[1].toLowerCase()}`;

  m = /^(?:Annex|Appendix)\s+([A-Z0-9]+)\b/i.exec(norm);
  if (m) return `annex:${m[1].toLowerCase()}`;

  m = /^Chapter\s+([IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.exec(norm);
  if (m) return `chapter:${normalizeRomanOrWordIndex(m[1])}`;

  m = /^(?:Section|Clause|Article)\s+([A-Z]\.\d+(?:\.\d+)*|\d+(?:\.\d+)*)\b/i.exec(norm);
  if (m) return `num:${m[1].toLowerCase()}`;

  // Mục con trong phụ lục: A.1, B.2.3, C.5.1.2.1 (chữ cái hoa)
  m = /^([A-Z]\.\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(norm);
  if (m) return `num:${m[1].toLowerCase()}`;

  // Mục thập phân: 1, 5.6.1, 12.3.4
  m = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(norm);
  if (m) return `num:${m[1]}`;

  return null;
}

export function hasConflictingStructuredPrefix(titleA: string, titleB: string): boolean {
  const prefA = extractStructuredPrefix(titleA);
  const prefB = extractStructuredPrefix(titleB);
  return prefA !== null && prefB !== null && prefA !== prefB;
}

export function crossCheckNodes(
  primary: TocNode[],
  reference: TocNode[],
  referenceSource: TocSource,
  opts: { appliedOffset?: number | null; mode?: 'coverage' | 'symmetric' } = {}
): CrossCheckSummary {
  const mode = opts.mode ?? 'coverage';
  if (primary.length === 0 || reference.length === 0) {
    return {
      comparedWith: referenceSource,
      appliedOffset: opts.appliedOffset ?? null,
      comparisonMode: mode,
      totalReferenceNodes: reference.length,
      matchedExact: 0,
      matchedPageDrift: 0,
      matchedLevelDiff: 0,
      missingFromPrimary: reference.length,
      extraInPrimary: primary.length,
      coverageRatio: 0,
      agreementRatio: 0,
      notes: ['insufficient_nodes_for_cross_check'],
      sampleDrifts: [],
      sampleMissing: [],
      sampleExtra: [],
    };
  }

  const matchedRefIdx = new Set<number>();
  const matchedPriIdx = new Set<number>();
  let matchedExact = 0;
  let matchedPageDrift = 0;
  let matchedLevelDiff = 0;
  const sampleDrifts: CrossCheckSummary['sampleDrifts'] = [];

  // Lập chỉ mục primary theo trang (để ưu tiên/bắt nhanh vùng ±2 trang) và theo token (để phát hiện lệch trang mà không quét O(N*M))
  const primaryPrefixes = primary.map((n) => extractStructuredPrefix(n.title));
  const primaryByPage = new Map<number, number[]>();
  const primaryByToken = new Map<string, number[]>();
  for (let pi = 0; pi < primary.length; pi++) {
    const pNode = primary[pi];
    const pageList = primaryByPage.get(pNode.page_pdf);
    if (pageList) pageList.push(pi);
    else primaryByPage.set(pNode.page_pdf, [pi]);

    for (const tok of getComparisonTokens(pNode.title)) {
      const tokList = primaryByToken.get(tok);
      if (tokList) tokList.push(pi);
      else primaryByToken.set(tok, [pi]);
    }
  }
  const seenStamp = new Int32Array(primary.length);

  // So sánh bất đối xứng theo độ phủ: với mỗi mục trong nguồn chuẩn (`reference`),
  // tìm nút khớp tốt nhất trong cây dựng (`primary`), ưu tiên khớp đúng trang.
  for (let ri = 0; ri < reference.length; ri++) {
    const rNode = reference[ri];
    const rPrefix = extractStructuredPrefix(rNode.title);
    const stamp = ri + 1;
    let bestPi = -1;
    let bestScore = -1;

    const considerCandidate = (pi: number) => {
      if (seenStamp[pi] === stamp || matchedPriIdx.has(pi)) return;
      seenStamp[pi] = stamp;
      const pPrefix = primaryPrefixes[pi];
      // Phạt/chặn xung đột tiền tố số hiệu (vd "5.6.1 General" không được ghép với "A.1 General")
      if (rPrefix !== null && pPrefix !== null && rPrefix !== pPrefix) return;
      const pNode = primary[pi];
      const titleSim = tokenOverlapScore(rNode.title, pNode.title);
      if (titleSim < 0.62) return;
      const pageDiff = Math.abs(pNode.page_pdf - rNode.page_pdf);
      const levelDiff = Math.abs(pNode.level - rNode.level);
      const totalScore = titleSim - Math.min(0.45, pageDiff * 0.04) - (levelDiff === 0 ? 0 : 0.02);
      if (totalScore > bestScore || (totalScore === bestScore && (bestPi < 0 || pi < bestPi))) {
        bestScore = totalScore;
        bestPi = pi;
      }
    };

    // 1. Quét nhanh các nút trong cửa sổ ±2 trang quanh rNode.page_pdf
    for (let pg = rNode.page_pdf - 2; pg <= rNode.page_pdf + 2; pg++) {
      const bucket = primaryByPage.get(pg);
      if (!bucket) continue;
      for (const pi of bucket) considerCandidate(pi);
    }
    // 2. Quét các nút chia sẻ ít nhất 1 token (bắt cả trường hợp lệch trang xa)
    for (const tok of getComparisonTokens(rNode.title)) {
      const bucket = primaryByToken.get(tok);
      if (!bucket) continue;
      for (const pi of bucket) considerCandidate(pi);
    }

    if (bestPi >= 0) {
      matchedRefIdx.add(ri);
      matchedPriIdx.add(bestPi);
      const pNode = primary[bestPi];
      const pageDiff = Math.abs(pNode.page_pdf - rNode.page_pdf);
      const levelDiff = Math.abs(pNode.level - rNode.level);
      if (pageDiff <= 1 && levelDiff === 0) {
        matchedExact++;
      } else {
        if (pageDiff > 1) {
          matchedPageDrift++;
          if (sampleDrifts.length < 5) {
            sampleDrifts.push({
              title: rNode.title,
              primaryPage: pNode.page_pdf,
              referencePage: rNode.page_pdf,
            });
          }
        }
        if (levelDiff > 0) matchedLevelDiff++;
      }
    }
  }

  const missingFromPrimary = reference.length - matchedRefIdx.size;
  const extraInPrimary = primary.length - matchedPriIdx.size;
  const coverageRatio = clampConfidence(matchedRefIdx.size / Math.max(1, reference.length));
  const denom =
    mode === 'coverage'
      ? Math.max(1, reference.length)
      : Math.max(1, Math.max(primary.length, reference.length));
  const agreementRatio = clampConfidence(
    (matchedExact + (matchedRefIdx.size - matchedExact) * 0.6) / denom
  );

  const sampleMissing = reference
    .filter((_, idx) => !matchedRefIdx.has(idx))
    .slice(0, 5)
    .map((n) => ({ title: n.title, referencePage: n.page_pdf }));

  const sampleExtra = primary
    .filter((_, idx) => !matchedPriIdx.has(idx))
    .slice(0, 5)
    .map((n) => ({ title: n.title, primaryPage: n.page_pdf }));

  const notes: string[] = [];
  if (matchedPageDrift > 0) notes.push(`page_drift=${matchedPageDrift}`);
  if (matchedLevelDiff > 0) notes.push(`level_diff=${matchedLevelDiff}`);
  if (missingFromPrimary > 0) notes.push(`missing=${missingFromPrimary}`);
  if (mode === 'symmetric' && extraInPrimary > 0) {
    notes.push(`extra=${extraInPrimary}`);
  }

  return {
    comparedWith: referenceSource,
    appliedOffset: opts.appliedOffset ?? null,
    comparisonMode: mode,
    totalReferenceNodes: reference.length,
    matchedExact,
    matchedPageDrift,
    matchedLevelDiff,
    missingFromPrimary,
    extraInPrimary,
    coverageRatio,
    agreementRatio,
    notes,
    sampleDrifts,
    sampleMissing,
    sampleExtra,
  };
}

function boostMatchedConfidence(nodes: TocNode[], reference: TocNode[]): TocNode[] {
  if (reference.length === 0) return nodes;
  const refByPage = new Map<number, TocNode[]>();
  for (const r of reference) {
    const bucket = refByPage.get(r.page_pdf);
    if (bucket) bucket.push(r);
    else refByPage.set(r.page_pdf, [r]);
  }
  return nodes.map((n) => {
    let matched = false;
    for (let pg = n.page_pdf - 1; pg <= n.page_pdf + 1 && !matched; pg++) {
      const bucket = refByPage.get(pg);
      if (!bucket) continue;
      for (const r of bucket) {
        if (!hasConflictingStructuredPrefix(r.title, n.title) && tokenOverlapScore(r.title, n.title) >= 0.68) {
          matched = true;
          break;
        }
      }
    }
    return matched ? { ...n, confidence: clampConfidence(Math.max(n.confidence, 0.96)) } : n;
  });
}

function mergeOutlineAndPrintedToc(
  outlineNodes: TocNode[],
  printedNodes: TocNode[],
  outlineMaxPage: number,
  outlineIsPartial: boolean
): TocNode[] {
  const combined: TocNode[] = [...boostMatchedConfidence(outlineNodes, printedNodes)];
  const existingByPage = new Map<number, Array<{ key: string; page: number; title: string }>>();
  for (const n of outlineNodes) {
    const item = { key: toComparisonKey(n.title), page: n.page_pdf, title: n.title };
    const bucket = existingByPage.get(n.page_pdf);
    if (bucket) bucket.push(item);
    else existingByPage.set(n.page_pdf, [item]);
  }

  for (const pNode of printedNodes) {
    const pKey = toComparisonKey(pNode.title);
    let alreadyCovered = false;
    for (let pg = pNode.page_pdf - 3; pg <= pNode.page_pdf + 3 && !alreadyCovered; pg++) {
      const bucket = existingByPage.get(pg);
      if (!bucket) continue;
      for (const ex of bucket) {
        if (hasConflictingStructuredPrefix(ex.title, pNode.title)) continue;
        const pageDiff = Math.abs(ex.page - pNode.page_pdf);
        if (
          (pageDiff <= 2 && tokenOverlapScore(ex.title, pNode.title) >= 0.65) ||
          (ex.key === pKey && pageDiff <= 3)
        ) {
          alreadyCovered = true;
          break;
        }
      }
    }
    if (alreadyCovered) continue;

    // Bổ sung mục ngoài vùng phủ của outline hoặc mục cấp sâu hơn nếu outline chỉ nông
    if (pNode.page_pdf > outlineMaxPage || outlineIsPartial || pNode.level >= 2) {
      combined.push({
        ...pNode,
        confidence: clampConfidence(pNode.confidence * 0.95),
      });
    }
  }

  // Giữ thứ tự tăng dần theo trang vật lý, sau đó ưu tiên outline hoặc sort ban đầu
  combined.sort((a, b) => {
    if (a.page_pdf !== b.page_pdf) return a.page_pdf - b.page_pdf;
    if (a.source === b.source) return a.sort - b.sort;
    return a.source === 'outline' ? -1 : 1;
  });

  return combined.map((n, idx) => ({ ...n, sort: idx + 1 }));
}

export function applyLimitsAndSanitize(
  rawNodes: TocNode[],
  totalPages: number,
  limits: TocLimits = DEFAULT_TOC_LIMITS
): {
  nodes: TocNode[];
  truncatedNodes: number;
  truncatedTitles: number;
  clampedDepths: number;
  exceededAction: 'none' | 'truncate' | 'fail';
  failedDueToLimits: boolean;
  failureReason?: string;
} {
  let truncatedTitles = 0;
  let clampedDepths = 0;

  if (limits.onLimitExceeded === 'fail') {
    if (rawNodes.length > limits.maxNodes) {
      return {
        nodes: [],
        truncatedNodes: 0,
        truncatedTitles: 0,
        clampedDepths: 0,
        exceededAction: 'fail',
        failedDueToLimits: true,
        failureReason: `node_count_exceeded(${rawNodes.length}>${limits.maxNodes})`,
      };
    }
    const deep = rawNodes.find((n) => n.level > limits.maxDepth);
    if (deep) {
      return {
        nodes: [],
        truncatedNodes: 0,
        truncatedTitles: 0,
        clampedDepths: 0,
        exceededAction: 'fail',
        failedDueToLimits: true,
        failureReason: `depth_exceeded(${deep.level}>${limits.maxDepth})`,
      };
    }
    const longNode = rawNodes.find((n) => normalizeUnicode(n.title).length > limits.maxTitleLength);
    if (longNode) {
      return {
        nodes: [],
        truncatedNodes: 0,
        truncatedTitles: 0,
        clampedDepths: 0,
        exceededAction: 'fail',
        failedDueToLimits: true,
        failureReason: `title_length_exceeded(${longNode.title.length}>${limits.maxTitleLength})`,
      };
    }
  }

  let working = rawNodes.filter(
    (n) => Number.isInteger(n.page_pdf) && n.page_pdf >= 1 && n.page_pdf <= totalPages
  );

  let truncatedNodes = 0;
  if (working.length > limits.maxNodes) {
    truncatedNodes = working.length - limits.maxNodes;
    working = working.slice(0, limits.maxNodes);
  }

  const sanitized: TocNode[] = working.map((n, idx) => {
    let title = normalizeUnicode(n.title);
    if (title.length > limits.maxTitleLength) {
      title = `${title.slice(0, Math.max(1, limits.maxTitleLength - 1)).trimEnd()}…`;
      truncatedTitles++;
    }
    let level = Math.max(1, Math.floor(n.level));
    if (level > limits.maxDepth) {
      level = limits.maxDepth;
      clampedDepths++;
    }
    return {
      title,
      level,
      page_pdf: n.page_pdf,
      sort: idx + 1,
      source: n.source,
      confidence: clampConfidence(n.confidence),
    };
  });

  const exceededAction =
    truncatedNodes > 0 || truncatedTitles > 0 || clampedDepths > 0 ? 'truncate' : 'none';

  return {
    nodes: sanitized,
    truncatedNodes,
    truncatedTitles,
    clampedDepths,
    exceededAction,
    failedDueToLimits: false,
  };
}

export interface CombineInput {
  pages: PageProfile[];
  outlineEval: OutlineEvaluation;
  printedToc: PrintedTocResult;
  bodyHeadings: { nodes: TocNode[]; suspiciousNodes: SuspiciousNode[] } | null;
  limits?: TocLimits;
}

export interface CombineOutput {
  status: TocStatus;
  strategy: string;
  reason?: string;
  flags: string[];
  nodes: TocNode[];
  /** Chỉ các nút nghi ngờ THỰC SỰ NẰM TRONG CÂY kết quả (`nodes`). */
  suspiciousNodes: SuspiciousNode[];
  /** Các dòng/mục nhiễu đã được bộ lọc loại đúng TRƯỚC khi đưa vào cây. */
  filteredNoise: SuspiciousNode[];
  crossCheck: CrossCheckSummary | null;
  limitsApplied: {
    truncatedNodes: number;
    truncatedTitles: number;
    clampedDepths: number;
    exceededAction: 'none' | 'truncate' | 'fail';
  };
}

const CLOSING_SIGNATURE_RE =
  /(?:nơi\s*nhận|noi\s*nhan|nlfi\s*nh|xác\s*thực|xac\s*th|chủ\s*nhiệm|chu\s*nhiem|chunhiem|bộ\s*trưởng|bo\s*truong|thứ\s*trưởng|thu\s*truong|kt\.\s*bộ|lưu\s*:|luu\s*:|ltru\s*:|văn\s*phòng\s*quốc\s*hội|van\s*phong\s*quoc|kính\s*gửi|ký\s*tên|đóng\s*dấu)/i;

const TRAILING_PAGE_HEADING_RE =
  /^(?:Chương|Phần|Mục|Điều\s+\d+|Phụ\s+lục|Chapter|Annex|Appendix)\b/i;

function isTrailingNonHeadingPage(
  page: PageProfile,
  totalPages: number,
  lastHeadingPage: number
): boolean {
  const isAtVeryEnd =
    page.pageNumber === totalPages || (totalPages >= 20 && page.pageNumber >= totalPages - 1);
  if (!isAtVeryEnd || page.pageNumber <= lastHeadingPage) return false;

  const pageText = page.lines.map((l) => normalizeUnicode(l.text)).join('\n');
  const hasClearHeading = page.lines.some(
    (l) => !l.isHeaderFooter && TRAILING_PAGE_HEADING_RE.test(normalizeUnicode(l.text))
  );
  if (hasClearHeading) return false;

  return (
    page.quality === 'image_only' ||
    page.nonSpaceCharCount < 350 ||
    CLOSING_SIGNATURE_RE.test(pageText)
  );
}

function isCoverOrFrontMatterImagePage(page: PageProfile, firstHeadingPage: number): boolean {
  return (
    page.quality === 'image_only' &&
    (page.pageNumber === 1 || (page.pageNumber <= 2 && page.pageNumber < firstHeadingPage))
  );
}

function isNonHeadingDiagramImagePage(page: PageProfile): boolean {
  if (page.quality !== 'image_only' || page.nonSpaceCharCount >= 50) return false;
  const hasHeadingLikeLine = page.lines.some((l) => {
    if (l.isHeaderFooter) return false;
    const t = normalizeUnicode(l.text);
    return TRAILING_PAGE_HEADING_RE.test(t) || /^\d+(?:\.\d+)*\.?\s+[\p{Lu}]/u.test(t);
  });
  return !hasHeadingLikeLine;
}

const BILINGUAL_TWO_COL_HEADING_RE = /^(\d+(?:\.\d+)*)\.?\s+\S.{2,90}\s+\1\.?\s+[A-Za-z]/;

function detectBilingualTwoColumn(pages: PageProfile[]): boolean {
  let hits = 0;
  for (const page of pages) {
    if (page.quality !== 'good') continue;
    for (const line of page.lines) {
      if (line.isHeaderFooter || line.isTocLine) continue;
      if (BILINGUAL_TWO_COL_HEADING_RE.test(normalizeUnicode(line.text))) {
        hits++;
        if (hits >= 4) return true;
      }
    }
  }
  return false;
}

function bodyHasMultiLevelStructure(
  pages: PageProfile[],
  bodyHeadingsNodes: TocNode[] | null
): boolean {
  if (bodyHeadingsNodes && bodyHeadingsNodes.filter((n) => n.level >= 2).length >= 8) {
    return true;
  }
  const seenMultiLevelPrefixes = new Set<string>();
  let hasChuong = false;
  let dieuCount = 0;

  for (const page of pages) {
    if (page.quality !== 'good') continue;
    for (const line of page.lines) {
      if (line.isHeaderFooter || line.isTocLine) continue;
      const norm = normalizeUnicode(line.text);
      if (!norm || norm.length > 160) continue;
      const subDec = /^(\d+\.\d+(?:\.\d+)*)\.?\s+[\p{L}]/u.exec(norm);
      if (subDec) {
        const top = Number.parseInt(subDec[1].split('.')[0], 10);
        if (top <= 100) {
          seenMultiLevelPrefixes.add(subDec[1]);
          if (seenMultiLevelPrefixes.size >= 8) return true;
        }
        continue;
      }
      const annexSub = /^([A-Z]\.\d+(?:\.\d+)*)\.?\s+[\p{L}]/u.exec(norm);
      if (annexSub) {
        seenMultiLevelPrefixes.add(annexSub[1]);
        if (seenMultiLevelPrefixes.size >= 8) return true;
        continue;
      }
      if (/^Chương\s+(?:[IVXLCDM]+|\d+)\b/i.test(norm)) hasChuong = true;
      if (/^Điều\s+\d+[a-z]?\s*[.:]/i.test(norm)) dieuCount++;
      if (hasChuong && dieuCount >= 5) return true;
    }
  }
  return false;
}

export function combineTocSources(input: CombineInput): CombineOutput {
  const { pages, outlineEval, printedToc, bodyHeadings } = input;
  const limits = input.limits ?? DEFAULT_TOC_LIMITS;
  const totalPages = pages.length;
  const goodPagesCount = pages.filter((p) => p.quality === 'good').length;
  const needsOcrCount = pages.filter((p) => p.needsOcr).length;
  const validTextPageRatio = totalPages > 0 ? goodPagesCount / totalPages : 0;
  const flags: string[] = [];

  // Tách riêng dòng/mục đã được lọc đúng (filteredNoise) khỏi nút nghi ngờ thực sự nằm trong cây (suspiciousNodes)
  const filteredNoise: SuspiciousNode[] = [
    ...(outlineEval.isUsable
      ? outlineEval.filteredOut
          .filter((f) => f.reason !== 'virtual_first_page')
          .map((f) => ({
            title: f.title,
            page_pdf: f.pagePdf ?? 1,
            level: 1,
            source: 'outline' as const,
            reason: `outline_filtered(${f.reason})`,
          }))
      : []),
    ...printedToc.suspiciousNodes.filter((s) => s.reason.startsWith('out_of_bounds_or_unmapped_page')),
    ...(bodyHeadings?.suspiciousNodes ?? []),
  ];

  // Quy tắc hạ status theo chất lượng chữ thực tế:
  // Tỉ lệ trang hợp lệ < 20% và không có outline sạch -> needs_ocr (trả cây rỗng, không cố đoán)
  if (
    !outlineEval.isUsable &&
    totalPages > 0 &&
    (goodPagesCount === 0 ||
      validTextPageRatio < 0.2 ||
      (needsOcrCount / totalPages >= 0.7 && !printedToc.isUsable && (bodyHeadings?.nodes.length ?? 0) < 2))
  ) {
    return {
      status: 'needs_ocr',
      strategy: 'none(needs_ocr)',
      reason:
        goodPagesCount === 0
          ? `no_reliable_text_layer(good=0/${totalPages},needs_ocr=${needsOcrCount})`
          : `low_valid_text_page_ratio(good=${goodPagesCount}/${totalPages}=${(validTextPageRatio * 100).toFixed(1)}%<20%,needs_ocr=${needsOcrCount})`,
      flags,
      nodes: [],
      suspiciousNodes: [],
      filteredNoise,
      crossCheck: null,
      limitsApplied: { truncatedNodes: 0, truncatedTitles: 0, clampedDepths: 0, exceededAction: 'none' },
    };
  }

  let selectedNodes: TocNode[] = [];
  let strategy = 'none';
  let status: TocStatus = 'ok';
  let reason: string | undefined;
  let crossCheck: CrossCheckSummary | null = null;

  if (outlineEval.isUsable) {
    const outlineMaxDepth = Math.max(1, ...outlineEval.nodes.map((n) => n.level));
    const outlineSpan = Math.max(1, outlineEval.maxPageCovered - outlineEval.minPageCovered + 1);
    const printedMaxDepth = printedToc.isUsable
      ? Math.max(1, ...printedToc.nodes.map((n) => n.level))
      : 0;
    const printedMinPage = printedToc.isUsable
      ? Math.min(...printedToc.nodes.map((n) => n.page_pdf))
      : 0;
    const printedMaxPage = printedToc.isUsable
      ? Math.max(...printedToc.nodes.map((n) => n.page_pdf))
      : 0;
    const printedSpan = printedToc.isUsable ? Math.max(1, printedMaxPage - printedMinPage + 1) : 0;

    const outlineShallowerThanPrinted =
      printedToc.isUsable &&
      outlineMaxDepth === 1 &&
      printedMaxDepth >= 2 &&
      printedToc.nodes.length >= outlineEval.nodes.length * 1.5;

    if (printedToc.isUsable) {
      crossCheck = crossCheckNodes(outlineEval.nodes, printedToc.nodes, 'printed_toc', {
        appliedOffset: printedToc.offset.primaryOffset,
      });
    }

    const printedReliable = printedToc.isUsable && printedToc.offset.confidence >= 0.75;
    const outlineCoverageVsPrinted = crossCheck?.coverageRatio ?? 1;

    // Nếu outline phủ ít hơn nhiều so với Contents in có offset tin cậy -> chọn printed_toc làm nguồn chính
    const outlineSeverelyUnderCoversPrinted =
      printedReliable &&
      printedToc.nodes.length >= 10 &&
      ((outlineEval.isPartial &&
        outlineCoverageVsPrinted < 0.45 &&
        printedSpan >= outlineSpan * 1.5) ||
        (outlineCoverageVsPrinted < 0.35 &&
          printedToc.nodes.length >= outlineEval.nodes.length * 3));

    if (outlineSeverelyUnderCoversPrinted) {
      strategy = 'printed_toc';
      selectedNodes = boostMatchedConfidence(printedToc.nodes, outlineEval.nodes);
      flags.push('outline_incomplete_fallback_printed_toc');
      const printedMaxLevel = Math.max(1, ...printedToc.nodes.map((n) => n.level));
      if (printedMaxLevel === 1 && bodyHasMultiLevelStructure(pages, bodyHeadings?.nodes ?? null)) {
        flags.push('contents_level1_only');
      }
    } else if (printedToc.isUsable && (outlineEval.isPartial || outlineShallowerThanPrinted)) {
      strategy = 'outline+printed_toc';
      selectedNodes = mergeOutlineAndPrintedToc(
        outlineEval.nodes,
        printedToc.nodes,
        outlineEval.maxPageCovered,
        outlineEval.isPartial
      );
      if (outlineEval.isPartial && selectedNodes.length > 0 && totalPages >= 10) {
        const mergedMin = Math.min(...selectedNodes.map((n) => n.page_pdf));
        const mergedMax = Math.max(...selectedNodes.map((n) => n.page_pdf));
        const stillHeadUncovered = mergedMin - 1 > Math.max(10, Math.ceil(totalPages * 0.2));
        const stillTailUncovered = totalPages - mergedMax > Math.max(8, Math.ceil(totalPages * 0.2));
        if (stillHeadUncovered || stillTailUncovered) {
          status = 'partial';
          flags.push('outline_incomplete');
          reason = outlineEval.partialReasons.join('; ');
        }
      }
    } else {
      strategy = 'outline';
      selectedNodes = printedToc.isUsable
        ? boostMatchedConfidence(outlineEval.nodes, printedToc.nodes)
        : outlineEval.nodes;
      if (outlineEval.isPartial) {
        status = 'partial';
        flags.push('outline_incomplete');
        reason = outlineEval.partialReasons.join('; ');
      } else if (
        printedReliable &&
        outlineCoverageVsPrinted < 0.4 &&
        printedToc.nodes.length >= 8
      ) {
        status = 'partial';
        flags.push('outline_incomplete');
        reason = `outline_low_coverage_vs_printed_toc(${outlineCoverageVsPrinted})`;
      }
    }
  } else if (printedToc.isUsable) {
    strategy = 'printed_toc';
    selectedNodes = printedToc.nodes;
    if (bodyHeadings && bodyHeadings.nodes.length >= 2) {
      crossCheck = crossCheckNodes(printedToc.nodes, bodyHeadings.nodes, 'body_headings', {
        appliedOffset: printedToc.offset.primaryOffset,
      });
    }
    const printedMaxLevel = Math.max(1, ...printedToc.nodes.map((n) => n.level));
    if (printedMaxLevel === 1 && bodyHasMultiLevelStructure(pages, bodyHeadings?.nodes ?? null)) {
      flags.push('contents_level1_only');
    }
  } else if (bodyHeadings && bodyHeadings.nodes.length >= 2) {
    strategy = 'body_headings';
    selectedNodes = bodyHeadings.nodes;
    if (needsOcrCount > 0) {
      const skippedPages = pages.filter((p) => p.needsOcr);
      const needsOcrRatio = totalPages > 0 ? needsOcrCount / totalPages : 0;
      const lastHeadingPage = bodyHeadings.nodes.reduce((m, n) => Math.max(m, n.page_pdf), 0);
      const firstHeadingPage = bodyHeadings.nodes.reduce(
        (m, n) => Math.min(m, n.page_pdf),
        totalPages
      );

      let trailingCount = 0;
      let coverCount = 0;
      let diagramImageCount = 0;
      let substantiveCount = 0;

      for (const sp of skippedPages) {
        if (isTrailingNonHeadingPage(sp, totalPages, lastHeadingPage)) {
          trailingCount++;
        } else if (isCoverOrFrontMatterImagePage(sp, firstHeadingPage)) {
          coverCount++;
        } else if (isNonHeadingDiagramImagePage(sp)) {
          diagramImageCount++;
        } else {
          substantiveCount++;
        }
      }

      if (substantiveCount === 0 && needsOcrRatio <= 0.25) {
        if (trailingCount > 0) flags.push('trailing_non_heading_ocr_page');
        if (coverCount > 0) flags.push('cover_image_page_skipped');
        if (diagramImageCount > 0) flags.push('minor_image_pages_skipped');
      } else {
        status = 'partial';
        reason = `skipped_${needsOcrCount}_needs_ocr_pages(${(needsOcrRatio * 100).toFixed(1)}%)`;
      }
    }
  } else {
    const failReason =
      printedToc.failureReason ??
      (needsOcrCount > 0 ? 'insufficient_clean_pages_for_toc' : 'no_reliable_toc_structure_found');
    return {
      status: needsOcrCount > totalPages * 0.5 ? 'needs_ocr' : 'failed',
      strategy: 'failed',
      reason: failReason,
      flags,
      nodes: [],
      suspiciousNodes: [],
      filteredNoise,
      crossCheck: null,
      limitsApplied: { truncatedNodes: 0, truncatedTitles: 0, clampedDepths: 0, exceededAction: 'none' },
    };
  }

  if (detectBilingualTwoColumn(pages)) {
    flags.push('bilingual_two_column_detected');
  }

  // Tỉ lệ trang hợp lệ < 50% -> status tối đa 'partial' (kể cả khi có outline hoặc Contents in)
  if (totalPages > 0 && validTextPageRatio < 0.5 && status === 'ok') {
    status = 'partial';
    const ratioNote = `low_valid_text_page_ratio(${goodPagesCount}/${totalPages}=${(validTextPageRatio * 100).toFixed(1)}%<50%)`;
    reason = reason ? `${reason}; ${ratioNote}` : ratioNote;
  }

  const limited = applyLimitsAndSanitize(selectedNodes, totalPages, limits);
  if (limited.failedDueToLimits) {
    return {
      status: 'failed',
      strategy,
      reason: limited.failureReason,
      flags,
      nodes: [],
      suspiciousNodes: [],
      filteredNoise,
      crossCheck,
      limitsApplied: {
        truncatedNodes: 0,
        truncatedTitles: 0,
        clampedDepths: 0,
        exceededAction: 'fail',
      },
    };
  }

  // Thu thập chỉ các nút nghi ngờ THỰC SỰ NẰM TRONG CÂY kết quả (`limited.nodes`)
  const suspiciousNodes: SuspiciousNode[] = [];
  for (let i = 0; i < limited.nodes.length; i++) {
    const n = limited.nodes[i];
    if (i > 0 && n.page_pdf < limited.nodes[i - 1].page_pdf) {
      suspiciousNodes.push({
        title: n.title,
        page_pdf: n.page_pdf,
        level: n.level,
        source: n.source,
        reason: `page_regressed_from_${limited.nodes[i - 1].page_pdf}`,
      });
    } else if (n.confidence < 0.55) {
      suspiciousNodes.push({
        title: n.title,
        page_pdf: n.page_pdf,
        level: n.level,
        source: n.source,
        reason: `low_confidence(${n.confidence})`,
      });
    }
  }

  return {
    status,
    strategy,
    reason,
    flags,
    nodes: limited.nodes,
    suspiciousNodes,
    filteredNoise,
    crossCheck,
    limitsApplied: {
      truncatedNodes: limited.truncatedNodes,
      truncatedTitles: limited.truncatedTitles,
      clampedDepths: limited.clampedDepths,
      exceededAction: limited.exceededAction,
    },
  };
}
