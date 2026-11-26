import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  decryptPdfWithQpdf,
  QpdfNotAvailableError,
  QpdfPasswordRequiredError,
  QpdfTimeoutError,
  type QpdfRunner,
} from '../previews/qpdf.js';
import { buildPageLines } from './line-builder.js';
import { assessPageTextQuality } from './text-quality.js';
import type { PageProfile, RawOutlineEntry, TextRun } from './types.js';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const WORKER_SRC = pathToFileURL(path.join(PDFJS_ROOT, 'legacy', 'build', 'pdf.worker.mjs')).href;
const CMAP_URL = pathToFileURL(path.join(PDFJS_ROOT, 'cmaps') + path.sep).href;
const STANDARD_FONT_URL = pathToFileURL(path.join(PDFJS_ROOT, 'standard_fonts') + path.sep).href;

pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;

const BOLD_FONT_RE = /(?:bold|black|heavy|semibold|demi|demibold|extrabold|ultrabold|cmbx|[-_,]b(?:d)?$)/i;
const ITALIC_FONT_RE = /(?:italic|oblique|slant|cmti|cmsl|[-_,]i(?:t)?$)/i;
const ENCRYPT_SCAN_HEAD_BYTES = 64 * 1024;
const ENCRYPT_SCAN_TAIL_BYTES = 128 * 1024;
const ENCRYPT_MARKER_RE = /\/Encrypt(?:\s+\d+\s+\d+\s+R|\s*<<)/;

const IMAGE_OPS = new Set<number>([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
  pdfjsLib.OPS.paintImageMaskXObjectRepeat,
  pdfjsLib.OPS.paintInlineImageXObjectGroup,
  pdfjsLib.OPS.paintImageMaskXObjectGroup,
  pdfjsLib.OPS.paintXObject,
]);

export interface LoadedPdfData {
  filePath: string;
  sizeBytes: number;
  isEncrypted: boolean;
  qpdfUsed: boolean;
  qpdfMs: number;
  extractMs: number;
  totalPages: number;
  rawOutline: RawOutlineEntry[];
  pages: PageProfile[];
  enrichFontStyles: (pageNumbers?: number[]) => Promise<void>;
  dispose: () => Promise<void>;
}

export interface LoadPdfOptions {
  qpdfPath?: string;
  qpdfTimeoutMs?: number;
  qpdfRunner?: QpdfRunner;
  createTempPath?: () => Promise<string>;
  discardTemp?: (tempPath: string) => Promise<void>;
}

export function hasPdfEncryptMarker(bytes: Uint8Array): boolean {
  const headSlice = bytes.subarray(0, Math.min(bytes.length, ENCRYPT_SCAN_HEAD_BYTES));
  const head = Buffer.from(headSlice.buffer, headSlice.byteOffset, headSlice.byteLength).toString('latin1');
  if (ENCRYPT_MARKER_RE.test(head)) return true;

  const tailStart = Math.max(0, bytes.length - ENCRYPT_SCAN_TAIL_BYTES);
  const tailSlice = bytes.subarray(tailStart);
  const tail = Buffer.from(tailSlice.buffer, tailSlice.byteOffset, tailSlice.byteLength).toString('latin1');
  return ENCRYPT_MARKER_RE.test(tail);
}

function isPdfjsPasswordError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const msg = (err as { message?: string }).message ?? '';
  return name === 'PasswordException' || /password/i.test(msg);
}

function checkFontFlags(fontName: string): { isBold: boolean; isItalic: boolean } {
  const clean = fontName.replace(/^[A-Z]{6}\+/, '');
  return {
    isBold: BOLD_FONT_RE.test(clean),
    isItalic: ITALIC_FONT_RE.test(clean),
  };
}

async function decryptViaSharedQpdf(
  absPath: string,
  opts: LoadPdfOptions
): Promise<{ decryptedPath: string; elapsedMs: number; cleanup: () => Promise<void> }> {
  const t0 = performance.now();
  const timeoutMs = opts.qpdfTimeoutMs ?? 15_000;

  let tempOutPath: string;
  let cleanup: () => Promise<void>;
  if (opts.createTempPath && opts.discardTemp) {
    tempOutPath = await opts.createTempPath();
    cleanup = async () => {
      await opts.discardTemp!(tempOutPath);
    };
  } else {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'elib-toc-qpdf-'));
    tempOutPath = path.join(tempDir, 'decrypted.pdf');
    cleanup = async () => {
      await rm(tempDir, { recursive: true, force: true });
    };
  }

  try {
    await decryptPdfWithQpdf(absPath, tempOutPath, {
      qpdfPath: opts.qpdfPath,
      timeoutMs,
      runner: opts.qpdfRunner,
    });
    return {
      decryptedPath: tempOutPath,
      elapsedMs: Math.round(performance.now() - t0),
      cleanup,
    };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err;
  }
}

async function resolveOutlineEntries(
  doc: pdfjsLib.PDFDocumentProxy
): Promise<RawOutlineEntry[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline || !Array.isArray(outline) || outline.length === 0) {
    return [];
  }

  const destCache = new Map<string, Array<unknown> | null>();
  const refPageCache = new Map<string, number | null>();

  const resolveDestToPagePdf = async (
    dest: string | Array<unknown> | null
  ): Promise<number | null> => {
    if (!dest) return null;
    let resolved: Array<unknown> | null = null;
    if (typeof dest === 'string') {
      if (destCache.has(dest)) {
        resolved = destCache.get(dest) ?? null;
      } else {
        resolved = await doc.getDestination(dest).catch(() => null);
        destCache.set(dest, resolved);
      }
    } else if (Array.isArray(dest)) {
      resolved = dest;
    }
    if (!resolved || resolved.length === 0) return null;

    const first = resolved[0];
    if (typeof first === 'number' && Number.isInteger(first)) {
      return first + 1;
    }
    if (first && typeof first === 'object' && 'num' in first && 'gen' in first) {
      const ref = first as { num: number; gen: number };
      const key = `${ref.num}_${ref.gen}`;
      if (refPageCache.has(key)) {
        return refPageCache.get(key) ?? null;
      }
      const idx = await doc.getPageIndex(ref as never).catch(() => null);
      const pagePdf = typeof idx === 'number' && Number.isInteger(idx) ? idx + 1 : null;
      refPageCache.set(key, pagePdf);
      return pagePdf;
    }
    return null;
  };

  const results: RawOutlineEntry[] = [];
  const walk = async (
    items: Array<{
      title: string;
      dest: string | Array<unknown> | null;
      items?: Array<unknown>;
    }>,
    level: number
  ): Promise<void> => {
    for (const item of items) {
      const pagePdf = await resolveDestToPagePdf(item.dest);
      results.push({
        title: typeof item.title === 'string' ? item.title : String(item.title ?? ''),
        level,
        pagePdf,
      });
      if (Array.isArray(item.items) && item.items.length > 0) {
        await walk(
          item.items as Array<{
            title: string;
            dest: string | Array<unknown> | null;
            items?: Array<unknown>;
          }>,
          level + 1
        );
      }
    }
  };

  await walk(outline, 1);
  return results;
}

async function openPdfjsDocument(bytes: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  return await loadingTask.promise;
}

/**
 * Tải PDF (giải mã trước bằng `qpdf` nếu mã hóa), trích outline và text+tọa độ từng trang.
 */
export async function loadPdfDocument(
  filePath: string,
  opts: LoadPdfOptions = {}
): Promise<LoadedPdfData> {
  const absPath = path.resolve(filePath);
  const originalBytes = new Uint8Array(await readFile(absPath));
  const sizeBytes = originalBytes.byteLength;

  let isEncrypted = hasPdfEncryptMarker(originalBytes);
  let qpdfUsed = false;
  let qpdfMs = 0;
  let qpdfCleanup: (() => Promise<void>) | null = null;
  let workingBytes: Uint8Array = originalBytes;

  if (isEncrypted) {
    const dec = await decryptViaSharedQpdf(absPath, opts);
    qpdfUsed = true;
    qpdfMs = dec.elapsedMs;
    qpdfCleanup = dec.cleanup;
    workingBytes = new Uint8Array(await readFile(dec.decryptedPath));
  }

  let doc: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    try {
      doc = await openPdfjsDocument(workingBytes);
    } catch (err) {
      if (!isEncrypted && isPdfjsPasswordError(err)) {
        isEncrypted = true;
        const dec = await decryptViaSharedQpdf(absPath, opts);
        qpdfUsed = true;
        qpdfMs = dec.elapsedMs;
        qpdfCleanup = dec.cleanup;
        workingBytes = new Uint8Array(await readFile(dec.decryptedPath));
        doc = await openPdfjsDocument(workingBytes);
      } else {
        throw err;
      }
    }

    const tExtractStart = performance.now();
    const totalPages = doc.numPages;
    const rawOutline = await resolveOutlineEntries(doc);
    const pages: PageProfile[] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent({ includeMarkedContent: false });
        const styles = textContent.styles ?? {};

        const runs: TextRun[] = [];

        for (const item of textContent.items) {
          if (!('str' in item)) continue;
          const str = item.str;
          if (!str) continue;

          const tr = item.transform as number[];
          const a = tr?.[0] ?? 0;
          const b = tr?.[1] ?? 0;
          const c = tr?.[2] ?? 0;
          const d = tr?.[3] ?? 0;
          const x = tr?.[4] ?? 0;
          const y = tr?.[5] ?? 0;
          const fontSize = Math.hypot(a, b) || Math.hypot(c, d) || item.height || 10;
          const width = Math.max(0, item.width ?? 0);
          const styleInfo = styles[item.fontName];
          const fontFamily = styleInfo?.fontFamily ?? '';
          const flags = checkFontFlags(`${item.fontName} ${fontFamily}`);

          runs.push({
            text: str,
            x,
            xEnd: x + width,
            y,
            width,
            height: item.height || fontSize,
            fontSize,
            fontName: item.fontName,
            isBold: flags.isBold,
            isItalic: flags.isItalic,
            hasEOL: item.hasEOL,
          });
        }

        const { lines, isMultiColumn } = buildPageLines({
          pageNumber: pageNum,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          runs,
        });

        const assembledPageText = lines.map((l) => l.text).join('\n');
        const nonSpaceCharCount = assembledPageText.replace(/\s+/g, '').length;

        let hasImageOps = false;
        if (nonSpaceCharCount < 50) {
          const opList = await page.getOperatorList().catch(() => null);
          if (opList && Array.isArray(opList.fnArray)) {
            hasImageOps = opList.fnArray.some((fn) => IMAGE_OPS.has(fn));
          }
        }

        const qualityAssessment = assessPageTextQuality(assembledPageText, hasImageOps);

        pages.push({
          pageNumber: pageNum,
          width: viewport.width,
          height: viewport.height,
          charCount: assembledPageText.length,
          nonSpaceCharCount,
          quality: qualityAssessment.quality,
          qualityScore: qualityAssessment.score,
          needsOcr: qualityAssessment.needsOcr,
          reasons: qualityAssessment.reasons,
          hasImageOps,
          isMultiColumn,
          lines,
        });
      } finally {
        page.cleanup();
      }
    }

    const extractMs = Math.round(performance.now() - tExtractStart);

    // Làm giàu cờ Bold/Italic từ tên font thật trong commonObjs (chỉ chạy khi cần phân tích body_headings)
    let fontEnriched = false;
    const enrichFontStyles = async (pageNumbers?: number[]): Promise<void> => {
      if (fontEnriched || !doc) return;
      const targets =
        pageNumbers ??
        pages.filter((p) => p.quality === 'good').map((p) => p.pageNumber);
      const fontMetaCache = new Map<string, { isBold: boolean; isItalic: boolean }>();

      for (const pn of targets) {
        const pageProf = pages[pn - 1];
        if (!pageProf || pageProf.lines.length === 0) continue;
        const page = await doc.getPage(pn);
        try {
          await page.getOperatorList().catch(() => null);
          for (const line of pageProf.lines) {
            let boldWeight = 0;
            let italicWeight = 0;
            let totalWeight = 0;
            for (const run of line.runs) {
              const w = run.text.replace(/\s+/g, '').length;
              if (w <= 0) continue;
              totalWeight += w;
              let meta = fontMetaCache.get(run.fontName);
              if (!meta) {
                let realName = run.fontName;
                try {
                  if (page.commonObjs.has(run.fontName)) {
                    const obj = page.commonObjs.get(run.fontName) as { name?: string } | undefined;
                    if (obj?.name) realName = `${run.fontName} ${obj.name}`;
                  }
                } catch {
                  // Bỏ qua nếu font chưa resolve
                }
                meta = checkFontFlags(realName);
                fontMetaCache.set(run.fontName, meta);
              }
              run.isBold = Boolean(run.isBold || meta.isBold);
              run.isItalic = Boolean(run.isItalic || meta.isItalic);
              if (run.isBold) boldWeight += w;
              if (run.isItalic) italicWeight += w;
            }
            if (totalWeight > 0) {
              line.isBold = boldWeight / totalWeight >= 0.55;
              line.isItalic = italicWeight / totalWeight >= 0.55;
            }
          }
        } finally {
          page.cleanup();
        }
      }

      // Bảo vệ: nếu > 70% tổng chữ thuộc nhóm "bold" (do tên font nền chứa từ khóa), bỏ cờ bold hàng loạt
      let totalChars = 0;
      let boldChars = 0;
      for (const pn of targets) {
        const p = pages[pn - 1];
        if (!p) continue;
        for (const l of p.lines) {
          if (l.isHeaderFooter) continue;
          const c = l.text.replace(/\s+/g, '').length;
          totalChars += c;
          if (l.isBold) boldChars += c;
        }
      }
      if (totalChars > 200 && boldChars / totalChars > 0.7) {
        for (const pn of targets) {
          const p = pages[pn - 1];
          if (!p) continue;
          for (const l of p.lines) {
            l.isBold = false;
          }
        }
      }

      fontEnriched = true;
    };

    const dispose = async (): Promise<void> => {
      try {
        if (doc) await doc.destroy();
      } finally {
        doc = null;
        if (qpdfCleanup) {
          await qpdfCleanup().catch(() => undefined);
          qpdfCleanup = null;
        }
      }
    };

    return {
      filePath: absPath,
      sizeBytes,
      isEncrypted,
      qpdfUsed,
      qpdfMs,
      extractMs,
      totalPages,
      rawOutline,
      pages,
      enrichFontStyles,
      dispose,
    };
  } catch (err) {
    if (doc) {
      await doc.destroy().catch(() => undefined);
    }
    if (qpdfCleanup) {
      await qpdfCleanup().catch(() => undefined);
    }
    if (
      err instanceof QpdfNotAvailableError ||
      err instanceof QpdfPasswordRequiredError ||
      err instanceof QpdfTimeoutError
    ) {
      throw err;
    }
    throw err;
  }
}
