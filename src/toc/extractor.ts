import {
  QpdfNotAvailableError,
  QpdfPasswordRequiredError,
  QpdfTimeoutError,
} from '../previews/qpdf.js';
import { combineTocSources } from './combiner.js';
import { markRepeatedHeadersFooters } from './headers-footers.js';
import { loadPdfDocument, type LoadPdfOptions } from './pdf-loader.js';
import { extractBodyHeadings } from './sources/body-headings.js';
import { evaluateOutline } from './sources/outline.js';
import { detectPrintedTocPages, extractPrintedToc } from './sources/printed-toc.js';
import {
  DEFAULT_TOC_LIMITS,
  type TocAutoPayload,
  type TocLimits,
  type TocSource,
} from './types.js';
import { TOC_ALGORITHM_VERSION, TOC_SCHEMA_VERSION } from './version.js';

export interface ExtractPdfTocOptions extends LoadPdfOptions {
  limits?: Partial<TocLimits>;
  runBodyCrossCheck?: boolean;
}

function buildUnsupportedPayload(reason: string): TocAutoPayload {
  return {
    schemaVersion: TOC_SCHEMA_VERSION,
    algorithmVersion: TOC_ALGORITHM_VERSION,
    status: 'unsupported',
    strategy: 'unsupported',
    reason,
    flags: [],
    totalPages: 0,
    offset: null,
    needsOcrPages: [],
    nodes: [],
    limitsApplied: {
      truncatedNodes: 0,
      truncatedTitles: 0,
      clampedDepths: 0,
      exceededAction: 'none',
    },
    stats: {
      sourceDistribution: { outline: 0, printed_toc: 0, body_headings: 0 },
      suspiciousInTreeCount: 0,
      filteredNoiseCount: 0,
      qpdfMs: 0,
      extractMs: 0,
      buildMs: 0,
    },
  };
}

/**
 * Trích xuất mục lục tự động cho một file PDF (cấu hình production mặc định
 * runBodyCrossCheck = false) và đóng gói thành payload lưu PostgreSQL.
 * PDF khóa mật khẩu mở / thiếu qpdf / timeout qpdf trả status 'unsupported'
 * thay vì ném lỗi để job nền không thử lặp vô ích.
 */
export async function extractPdfToc(
  filePath: string,
  opts: ExtractPdfTocOptions = {}
): Promise<TocAutoPayload> {
  try {
    const loaded = await loadPdfDocument(filePath, opts);
    try {
      const tBuildStart = performance.now();
      markRepeatedHeadersFooters(loaded.pages);

      const outlineEval = evaluateOutline(loaded.rawOutline, loaded.totalPages, loaded.pages);
      const outlineMaxDepth =
        outlineEval.nodes.length > 0 ? Math.max(1, ...outlineEval.nodes.map((n) => n.level)) : 0;
      const outlineIsCleanAndComplete =
        outlineEval.isUsable &&
        !outlineEval.isPartial &&
        (outlineMaxDepth >= 2 || loaded.totalPages <= 15);

      const tocPages =
        !outlineIsCleanAndComplete || opts.runBodyCrossCheck === true
          ? detectPrintedTocPages(loaded.pages)
          : [];
      const printedToc = outlineIsCleanAndComplete
        ? {
            tocPages,
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
              notRequiredReason: 'outline_used',
            },
            suspiciousNodes: [],
            isUsable: false,
            failureReason: 'skipped_clean_outline',
          }
        : extractPrintedToc(loaded.pages, tocPages);

      const needBodyHeadings =
        (!outlineEval.isUsable && !printedToc.isUsable) || opts.runBodyCrossCheck === true;

      let bodyHeadings: ReturnType<typeof extractBodyHeadings> | null = null;
      if (needBodyHeadings) {
        const goodPagesToEnrich = loaded.pages
          .filter((p) => p.quality === 'good')
          .map((p) => p.pageNumber);
        if (goodPagesToEnrich.length > 0) {
          await loaded.enrichFontStyles(goodPagesToEnrich);
        }
        bodyHeadings = extractBodyHeadings(loaded.pages, tocPages);
      }

      const limits: TocLimits = { ...DEFAULT_TOC_LIMITS, ...(opts.limits ?? {}) };
      const combined = combineTocSources({
        pages: loaded.pages,
        outlineEval,
        printedToc,
        bodyHeadings,
        limits,
      });

      const buildMs = Math.round(performance.now() - tBuildStart);
      const sourceDistribution: Record<TocSource, number> = {
        outline: 0,
        printed_toc: 0,
        body_headings: 0,
      };
      for (const n of combined.nodes) {
        sourceDistribution[n.source]++;
      }

      const needsOcrPages = loaded.pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);

      let resolvedOffset = printedToc.tocPages.length > 0 ? printedToc.offset : null;
      if (combined.strategy === 'outline' && (!resolvedOffset || resolvedOffset.primaryOffset === null)) {
        const notRequiredReason =
          printedToc.tocPages.length > 0 && printedToc.hasPageNumbers === false
            ? 'outline_used_pageless_toc'
            : 'outline_used';
        resolvedOffset = {
          ...(resolvedOffset ?? {
            primaryOffset: null,
            confidence: 0,
            anchorsTested: 0,
            anchorsMatched: 0,
            anchorsConsistent: 0,
            piecewiseOffsets: [],
            romanOffset: null,
            romanConfidence: 0,
            samples: [],
          }),
          notRequiredReason,
        };
      }

      return {
        schemaVersion: TOC_SCHEMA_VERSION,
        algorithmVersion: TOC_ALGORITHM_VERSION,
        status: combined.status,
        strategy: combined.strategy,
        reason: combined.reason ?? null,
        flags: combined.flags,
        totalPages: loaded.totalPages,
        offset: resolvedOffset,
        needsOcrPages,
        nodes: combined.nodes,
        limitsApplied: combined.limitsApplied,
        stats: {
          sourceDistribution,
          suspiciousInTreeCount: combined.suspiciousNodes.length,
          filteredNoiseCount: combined.filteredNoise.length,
          qpdfMs: loaded.qpdfMs,
          extractMs: loaded.extractMs,
          buildMs,
        },
      };
    } finally {
      await loaded.dispose();
    }
  } catch (err) {
    if (
      err instanceof QpdfPasswordRequiredError ||
      err instanceof QpdfNotAvailableError ||
      err instanceof QpdfTimeoutError
    ) {
      return buildUnsupportedPayload(err.message);
    }
    throw err;
  }
}
