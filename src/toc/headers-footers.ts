import { normalizeUnicode } from './normalize.js';
import type { PageLine, PageProfile } from './types.js';

const STANDALONE_PAGE_NUMBER_RE =
  /^\s*[-–—[\]()]*\s*(?:page\s+\d+(?:\s+of\s+\d+)?|trang\s+\d+(?:\s*\/\s*\d+)?|[ivxlcdm]{1,7}|\d{1,4})\s*[-–—[\]()]*\s*$/i;

const LICENSE_OR_COPYRIGHT_HINT_RE =
  /(?:copyright|all\s+rights\s+reserved|licensed\s+to|downloaded\s+from|single[- ]user\s+license|bản\s+quyền|cung\s+cấp\s+bởi|not\s+for\s+resale|reproduction\s+prohibited)/i;

/**
 * Chuẩn hóa dòng header/footer thành khung mẫu (skeleton) để phát hiện lặp lại
 * dù số trang, ngày tháng hay mã số trang thay đổi từng trang
 * (vd "ETSI TS ... V2.3.0 (2013-07) 14", "Eddy Standards Track [Page 7]").
 */
export function buildHeaderFooterSkeleton(raw: string): string {
  let text = normalizeUnicode(raw).toLowerCase();
  // Chuẩn hóa [page 12], page 12 of 90, trang 12
  text = text
    .replace(/\[?\b(?:page|trang)\s+\d+(?:\s*(?:of|\/)\s*\d+)?\b\]?/gi, '<page>')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  // Bỏ số La Mã đứng riêng ở đầu hoặc cuối
  text = text.replace(/^(?:[ivxlcdm]{1,6})\s+/i, '# ').replace(/\s+(?:[ivxlcdm]{1,6})$/i, ' #');
  return text;
}

interface Occurrence {
  pageNumber: number;
  line: PageLine;
  band: 'top' | 'bottom' | 'body';
  yBucket: number;
  xBucket: number;
  skeleton: string;
}

/**
 * Phát hiện đầu/chân trang và dòng giấy phép/watermark lặp lại trên nhiều trang cùng vị trí,
 * gắn cờ `isHeaderFooter = true` (và `isLicenseOrWatermark = true` nếu là dòng giấy phép).
 */
export function markRepeatedHeadersFooters(pages: PageProfile[]): {
  markedLinesCount: number;
  patternsDetected: number;
} {
  const goodPages = pages.filter((p) => p.quality === 'good');
  const goodCount = goodPages.length;
  if (goodCount < 3) {
    // Với tài liệu rất ngắn (< 3 trang good), chỉ bỏ số trang đứng trơ trọi ở mép trên/dưới
    let marked = 0;
    for (const page of goodPages) {
      const h = page.height || 842;
      for (const line of page.lines) {
        const inEdgeBand = line.y >= h * 0.88 || line.y <= h * 0.12;
        if (inEdgeBand && STANDALONE_PAGE_NUMBER_RE.test(line.text)) {
          line.isHeaderFooter = true;
          marked++;
        }
      }
    }
    return { markedLinesCount: marked, patternsDetected: marked > 0 ? 1 : 0 };
  }

  const edgeThreshold = goodCount <= 5 ? 2 : Math.max(3, Math.ceil(goodCount * 0.15));
  const bodyWatermarkThreshold = Math.max(3, Math.ceil(goodCount * 0.45));

  const edgeGroups = new Map<string, Occurrence[]>();
  const bodyGroups = new Map<string, Occurrence[]>();

  let markedLinesCount = 0;
  let patternsDetected = 0;

  for (const page of goodPages) {
    const h = page.height > 0 ? page.height : 842;
    const w = page.width > 0 ? page.width : 595;

    for (const line of page.lines) {
      const norm = normalizeUnicode(line.text);
      if (!norm) continue;

      const isTopBand = line.y >= h * 0.89;
      const isBottomBand = line.y <= h * 0.11;

      if ((isTopBand || isBottomBand) && STANDALONE_PAGE_NUMBER_RE.test(norm)) {
        if (!line.isHeaderFooter) {
          line.isHeaderFooter = true;
          markedLinesCount++;
        }
        continue;
      }

      const skeleton = buildHeaderFooterSkeleton(norm);
      if (!skeleton || skeleton.length < 2) continue;

      const yBucket = Math.round((line.y / h) * 40);
      const xBucket = Math.round((line.x / w) * 20);

      if (isTopBand || isBottomBand) {
        const band = isTopBand ? 'top' : 'bottom';
        // Cho phép chênh yBucket ±1 (trường hợp chẵn/lẻ hoặc sai lệch PDF nhẹ)
        const key = `${band}:${Math.floor(yBucket / 2)}:${skeleton}`;
        const list = edgeGroups.get(key) ?? [];
        list.push({ pageNumber: page.pageNumber, line, band, yBucket, xBucket, skeleton });
        edgeGroups.set(key, list);
      } else if (norm.length >= 12) {
        // Trong vùng thân bài, chỉ xem là watermark/giấy phép lặp nếu nguyên văn giống hệt hoặc mang từ khóa giấy phép
        const isLicHint = LICENSE_OR_COPYRIGHT_HINT_RE.test(norm);
        const bodyMatchKey = isLicHint ? skeleton : norm.toLowerCase();
        const key = `body:${xBucket}:${yBucket}:${bodyMatchKey}`;
        const list = bodyGroups.get(key) ?? [];
        list.push({ pageNumber: page.pageNumber, line, band: 'body', yBucket, xBucket, skeleton: bodyMatchKey });
        bodyGroups.set(key, list);
      }
    }
  }

  const markGroup = (occs: Occurrence[], minPages: number, forceWatermarkFlag = false): void => {
    const uniquePages = new Set(occs.map((o) => o.pageNumber));
    if (uniquePages.size < minPages) return;
    patternsDetected++;
    for (const occ of occs) {
      const isLic = forceWatermarkFlag || LICENSE_OR_COPYRIGHT_HINT_RE.test(occ.line.text);
      if (!occ.line.isHeaderFooter) {
        occ.line.isHeaderFooter = true;
        markedLinesCount++;
      }
      if (isLic) {
        occ.line.isLicenseOrWatermark = true;
      }
    }
  };

  for (const occs of edgeGroups.values()) {
    markGroup(occs, edgeThreshold, false);
  }
  for (const occs of bodyGroups.values()) {
    markGroup(occs, bodyWatermarkThreshold, true);
  }

  return { markedLinesCount, patternsDetected };
}
