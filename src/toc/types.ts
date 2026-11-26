export type TocSource = 'outline' | 'printed_toc' | 'body_headings';
export type StoredTocSource = TocSource | 'manual';

export type TocStatus = 'ok' | 'partial' | 'needs_ocr' | 'failed' | 'unsupported';
export type TocJobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'unsupported';

export type PageTextQuality = 'good' | 'garbled_ocr' | 'image_only' | 'empty';

export interface TocNode {
  title: string;
  level: number;
  page_pdf: number;
  sort: number;
  source: TocSource;
  confidence: number;
}

export interface StoredTocNode {
  title: string;
  level: number;
  page_pdf: number;
  sort: number;
  source: StoredTocSource;
  confidence: number;
}

export interface TocLimits {
  maxNodes: number;
  maxDepth: number;
  maxTitleLength: number;
  onLimitExceeded: 'truncate' | 'fail';
}

export const DEFAULT_TOC_LIMITS: TocLimits = {
  maxNodes: 2000,
  maxDepth: 6,
  maxTitleLength: 200,
  onLimitExceeded: 'truncate',
};

export interface TextRun {
  text: string;
  x: number;
  xEnd: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  isBold?: boolean;
  isItalic?: boolean;
  hasEOL?: boolean;
}

export interface PageLine {
  pageNumber: number;
  text: string;
  rawText: string;
  normalizedText: string;
  x: number;
  xEnd: number;
  y: number;
  width: number;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  isAllCaps: boolean;
  isCentered: boolean;
  hasDotLeader: boolean;
  trailingPageToken: string | null;
  trailingPageGap: number;
  isHeaderFooter: boolean;
  isLicenseOrWatermark: boolean;
  isTocLine?: boolean;
  hadSuperscriptStripped: boolean;
  runs: TextRun[];
}

export interface PageQualityAssessment {
  quality: PageTextQuality;
  score: number;
  needsOcr: boolean;
  reasons: string[];
}

export interface PageProfile {
  pageNumber: number;
  width: number;
  height: number;
  charCount: number;
  nonSpaceCharCount: number;
  quality: PageTextQuality;
  qualityScore: number;
  needsOcr: boolean;
  reasons: string[];
  hasImageOps: boolean;
  isMultiColumn: boolean;
  lines: PageLine[];
}

export interface RawOutlineEntry {
  title: string;
  level: number;
  pagePdf: number | null;
}

export interface OutlineEvaluation {
  nodes: TocNode[];
  rawCount: number;
  rawMaxDepth: number;
  filteredOut: Array<{ title: string; reason: string; pagePdf: number | null }>;
  validRatio: number;
  junkTitleRatio: number;
  monotonicRatio: number;
  minPageCovered: number;
  maxPageCovered: number;
  pageSpanRatio: number;
  samePageBurstRatio: number;
  isUsable: boolean;
  isPartial: boolean;
  partialReasons: string[];
  rejectedReason?: string;
}

export interface PrintedTocAnchorMatch {
  title: string;
  printedPage: string;
  printedNumeric: number;
  kind: 'arabic' | 'roman' | 'prefixed';
  matchedPdfPage: number;
  offset: number;
  matchScore: number;
}

export interface OffsetInfo {
  primaryOffset: number | null;
  confidence: number;
  anchorsTested: number;
  anchorsMatched: number;
  anchorsConsistent: number;
  piecewiseOffsets: Array<{
    fromPrintedPage: number;
    offset: number;
    matchedCount: number;
  }>;
  romanOffset: number | null;
  romanConfidence: number;
  notRequiredReason?: string;
  samples: PrintedTocAnchorMatch[];
}

export interface PrintedTocResult {
  tocPages: number[];
  rawEntriesCount: number;
  pagelessEntriesCount?: number;
  hasPageNumbers?: boolean;
  nodes: TocNode[];
  offset: OffsetInfo;
  suspiciousNodes: SuspiciousNode[];
  isUsable: boolean;
  failureReason?: string;
}

export interface SuspiciousNode {
  title: string;
  page_pdf: number;
  level: number;
  source: TocSource;
  reason: string;
}

export interface CrossCheckSummary {
  comparedWith: TocSource;
  appliedOffset?: number | null;
  comparisonMode?: 'coverage' | 'symmetric';
  totalReferenceNodes: number;
  matchedExact: number;
  matchedPageDrift: number;
  matchedLevelDiff: number;
  missingFromPrimary: number;
  extraInPrimary: number;
  coverageRatio?: number;
  agreementRatio: number;
  notes: string[];
  sampleDrifts: Array<{ title: string; primaryPage: number; referencePage: number }>;
  sampleMissing: Array<{ title: string; referencePage: number }>;
  sampleExtra: Array<{ title: string; primaryPage: number }>;
}

export interface TocAutoPayload {
  schemaVersion: number;
  algorithmVersion: string;
  status: TocStatus;
  strategy: string;
  reason: string | null;
  flags: string[];
  totalPages: number;
  offset: OffsetInfo | null;
  needsOcrPages: number[];
  nodes: TocNode[];
  limitsApplied: {
    truncatedNodes: number;
    truncatedTitles: number;
    clampedDepths: number;
    exceededAction: 'none' | 'truncate' | 'fail';
  };
  stats: {
    sourceDistribution: Record<TocSource, number>;
    suspiciousInTreeCount: number;
    filteredNoiseCount: number;
    qpdfMs: number;
    extractMs: number;
    buildMs: number;
  };
}

export interface TocManualPayload {
  schemaVersion: number;
  updatedFromAlgorithmVersion: string | null;
  note: string | null;
  nodes: StoredTocNode[];
}

export interface TocFileSummary {
  toc_job_status: TocJobStatus | null;
  toc_status: TocStatus | null;
  toc_has_manual: boolean;
  toc_algorithm_version: string | null;
}
