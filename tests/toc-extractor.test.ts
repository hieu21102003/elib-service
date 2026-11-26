import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  QpdfPasswordRequiredError,
  decryptPdfWithQpdf,
  type QpdfRunner,
} from '../src/previews/qpdf.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import {
  combineTocSources,
  crossCheckNodes,
  extractStructuredPrefix,
  hasConflictingStructuredPrefix,
} from '../src/toc/combiner.js';
import { extractPdfToc } from '../src/toc/extractor.js';
import { markRepeatedHeadersFooters } from '../src/toc/headers-footers.js';
import { buildPageLines } from '../src/toc/line-builder.js';
import {
  cleanTocTitle,
  isTableOrFigureCaption,
  normalizeUnicode,
  stripTrailingFootnoteMarker,
  toComparisonKey,
} from '../src/toc/normalize.js';
import { hasPdfEncryptMarker } from '../src/toc/pdf-loader.js';
import { extractBodyHeadings } from '../src/toc/sources/body-headings.js';
import { evaluateOutline } from '../src/toc/sources/outline.js';
import { detectPrintedTocPages, extractPrintedToc } from '../src/toc/sources/printed-toc.js';
import { assessPageTextQuality } from '../src/toc/text-quality.js';
import type { PageProfile, TextRun } from '../src/toc/types.js';
import { TOC_ALGORITHM_VERSION, TOC_SCHEMA_VERSION } from '../src/toc/version.js';
import { makeRc4EncryptedPdf } from './helpers/encrypted-pdf.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'elib-toc-ext-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeRun(
  text: string,
  x: number,
  y: number,
  fontSize = 11,
  opts: { isBold?: boolean; width?: number } = {}
): TextRun {
  const width = opts.width ?? text.length * fontSize * 0.52;
  return {
    text,
    x,
    xEnd: x + width,
    y,
    width,
    height: fontSize,
    fontSize,
    fontName: opts.isBold ? 'Times-Bold' : 'Times-Roman',
    isBold: opts.isBold ?? false,
    isItalic: false,
  };
}

function makeGoodPage(
  pageNumber: number,
  runs: TextRun[],
  width = 595,
  height = 842
): PageProfile {
  const { lines, isMultiColumn } = buildPageLines({
    pageNumber,
    pageWidth: width,
    pageHeight: height,
    runs,
  });
  const text = lines.map((l) => l.text).join('\n');
  return {
    pageNumber,
    width,
    height,
    charCount: text.length,
    nonSpaceCharCount: text.replace(/\s+/g, '').length,
    quality: 'good',
    qualityScore: 1,
    needsOcr: false,
    reasons: [],
    hasImageOps: false,
    isMultiColumn,
    lines,
  };
}

async function buildSamplePdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const addLinesPage = (items: Array<{ text: string; size?: number; bold?: boolean; y?: number }>) => {
    const p = doc.addPage([595, 842]);
    let y = 760;
    for (const item of items) {
      const py = item.y ?? y;
      p.drawText(item.text, {
        x: 60,
        y: py,
        size: item.size ?? 11,
        font: item.bold ? fontBold : fontReg,
      });
      y = py - 22;
    }
  };

  addLinesPage([
    { text: 'TECHNICAL SPECIFICATION SAMPLE', size: 18, bold: true },
    { text: 'Standard Reference Document for Offset Testing', size: 12 },
  ]);
  addLinesPage([
    { text: 'Preface', size: 15, bold: true },
    { text: 'This preface provides background context before the main body clauses.', size: 11 },
    { text: 'i', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: 'Contents', size: 15, bold: true },
    { text: 'Preface ............................................................. i', size: 11 },
    { text: '1 Introduction ...................................................... 1', size: 11 },
    { text: '1.1 Scope and purpose ............................................... 2', size: 11 },
    { text: 'ii', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: '2 Core Requirements ................................................. 3', size: 11 },
    { text: 'Annex ZZ (informative): Relationship between this present', size: 11 },
    { text: 'document and the essential requirements of the', size: 11 },
    { text: 'applicable directive ................................................ 5', size: 11 },
    { text: 'iii', size: 10, y: 50 },
  ]);
  addLinesPage([{ text: 'This page is intentionally left blank for duplex printing layout.' }]);
  addLinesPage([
    { text: '1 Introduction', size: 14, bold: true },
    { text: 'This document specifies requirements for electronic library indexing.', size: 11 },
    { text: '1', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: '1.1 Scope and purpose', size: 13, bold: true },
    { text: 'Scope covers single and multi-page structured documents.', size: 11 },
    { text: '2', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: '2 Core Requirements', size: 14, bold: true },
    { text: 'All requirements are normative unless stated otherwise.', size: 11 },
    { text: '3', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: 'Additional normative verification details appear on this page.', size: 11 },
    { text: '4', size: 10, y: 50 },
  ]);
  addLinesPage([
    { text: 'Annex ZZ (informative):', size: 14, bold: true },
    { text: 'Relationship between this present document and the essential', size: 13, bold: true },
    { text: 'requirements of the applicable directive', size: 13, bold: true },
    { text: '5', size: 10, y: 50 },
  ]);

  return await doc.save();
}

describe('src/toc/extractor — chuẩn hóa, offset, qpdf, chất lượng chữ & quy tắc TCVN Vòng 3', () => {
  it('1. Chuẩn hóa Unicode + chỉ số trên + không cắt mã kỹ thuật', () => {
    const raw = 'ETSI\u00A0EN\u00A0301\u2011549\u200B V4.1.1 — Speciﬁcation';
    expect(normalizeUnicode(raw)).toBe('ETSI EN 301-549 V4.1.1 - Specification');
    expect(toComparisonKey(raw)).toBe('etsi en 301 549 v4 1 1 specification');

    expect(stripTrailingFootnoteMarker('ĐIỀU KHOẢN THI HÀNH9')).toEqual({
      text: 'ĐIỀU KHOẢN THI HÀNH',
      stripped: true,
    });
    expect(stripTrailingFootnoteMarker('Giao thức IPv6').stripped).toBe(false);
    expect(cleanTocTitle('Annex A1').title).toBe('Annex A1');

    const { lines } = buildPageLines({
      pageNumber: 5,
      pageWidth: 595,
      pageHeight: 842,
      runs: [
        makeRun('Chương III. ', 72, 700, 13, { isBold: true }),
        makeRun('ĐIỀU KHOẢN THI HÀNH', 150, 700, 13, { isBold: true }),
        makeRun('9', 282, 705, 7.5, { isBold: false }),
      ],
    });
    expect(lines[0].text).toBe('Chương III. ĐIỀU KHOẢN THI HÀNH');
    expect(lines[0].hadSuperscriptStripped).toBe(true);
  });

  it('2. extractPdfToc chạy end-to-end trên PDF thật tạo bằng pdf-lib (offset +5, La Mã, algorithmVersion)', async () => {
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, 'dynamic-offset.pdf');
    await writeFile(pdfPath, await buildSamplePdfBytes());

    const payload = await extractPdfToc(pdfPath);
    expect(payload.schemaVersion).toBe(TOC_SCHEMA_VERSION);
    expect(payload.algorithmVersion).toBe(TOC_ALGORITHM_VERSION);
    expect(payload.status).toBe('ok');
    expect(payload.strategy).toBe('printed_toc');
    expect(payload.totalPages).toBe(10);
    expect(payload.offset?.primaryOffset).toBe(5);
    expect(payload.offset?.romanOffset).toBe(1);
    expect(payload.nodes.find((n) => n.title === 'Preface')?.page_pdf).toBe(2);
    expect(payload.nodes.find((n) => n.title.includes('1 Introduction'))?.page_pdf).toBe(6);
    expect(payload.nodes.find((n) => n.title.includes('Annex ZZ'))?.page_pdf).toBe(10);
  });

  it('3. extractPdfToc với PDF mã hóa RC4 dùng decryptPdfWithQpdf qua temp storage và dọn sạch file tạm', async () => {
    const dir = await makeTempDir();
    const storage = new LocalDiskStorage(path.join(dir, 'storage'));
    const encPath = path.join(dir, 'encrypted.pdf');
    await writeFile(encPath, makeRc4EncryptedPdf({ pageCount: 10, userPassword: '' }));

    const plainBytes = await buildSamplePdfBytes();
    const qpdfCalls: string[][] = [];
    const runner: QpdfRunner = async (_bin, args) => {
      qpdfCalls.push([...args]);
      const outPath = args[args.length - 1];
      await writeFile(outPath, plainBytes);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    };

    const payload = await extractPdfToc(encPath, {
      qpdfRunner: runner,
      createTempPath: () => storage.createTempPath(),
      discardTemp: (p) => storage.discardTemp(p),
    });

    expect(payload.status).toBe('ok');
    expect(payload.nodes.length).toBeGreaterThanOrEqual(4);
    expect(payload.stats.qpdfMs).toBeGreaterThanOrEqual(0);
    expect(qpdfCalls).toHaveLength(1);
    expect(qpdfCalls[0].slice(0, 2)).toEqual(['--password=', '--decrypt']);

    const tmpEntries = await readdir(path.join(storage.root, 'tmp'));
    expect(tmpEntries).toEqual([]);
  });

  it('4. PDF khóa mật khẩu mở -> trả status unsupported + dọn sạch file tạm', async () => {
    const dir = await makeTempDir();
    const storage = new LocalDiskStorage(path.join(dir, 'storage'));
    const lockedPath = path.join(dir, 'locked.pdf');
    await writeFile(lockedPath, makeRc4EncryptedPdf({ pageCount: 4, userPassword: 'secret' }));

    const runner: QpdfRunner = async (_bin, args) => ({
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: `qpdf: ${args[2]}: invalid password`,
    });

    await expect(
      decryptPdfWithQpdf(lockedPath, await storage.createTempPath(), { timeoutMs: 2000, runner })
    ).rejects.toBeInstanceOf(QpdfPasswordRequiredError);

    const payload = await extractPdfToc(lockedPath, {
      qpdfRunner: runner,
      createTempPath: () => storage.createTempPath(),
      discardTemp: (p) => storage.discardTemp(p),
    });
    expect(payload.status).toBe('unsupported');
    expect(payload.strategy).toBe('unsupported');
    expect(payload.nodes).toEqual([]);
  });

  it('5. Phát hiện offset phân đoạn (piecewise), trả failed an toàn khi không khớp neo, và áp trần maxTitleLength=200', () => {
    const pages: PageProfile[] = [
      makeGoodPage(1, [
        makeRun('Contents', 72, 760, 14, { isBold: true }),
        makeRun('1. Overview .............................. 1', 72, 730, 11),
        makeRun('2. Architecture .......................... 2', 72, 710, 11),
        makeRun('Annex A (normative) Protocol ............. 3', 72, 690, 11),
        makeRun('Annex B (informative) Examples ........... 4', 72, 670, 11),
      ]),
      makeGoodPage(2, [makeRun('Foreword and copyright notice for this technical publication.', 72, 700, 11)]),
      makeGoodPage(3, [makeRun('1. Overview', 72, 740, 13, { isBold: true })]),
      makeGoodPage(4, [makeRun('2. Architecture', 72, 740, 13, { isBold: true })]),
      makeGoodPage(5, [makeRun('PART II: ANNEXES DIVIDER', 150, 500, 14, { isBold: true })]),
      makeGoodPage(6, [makeRun('Annex A (normative) Protocol', 72, 740, 13, { isBold: true })]),
      makeGoodPage(7, [makeRun('Annex B (informative) Examples', 72, 740, 13, { isBold: true })]),
    ];

    const res = extractPrintedToc(pages);
    expect(res.isUsable).toBe(true);
    expect(res.offset.primaryOffset).toBe(2);
    expect(res.offset.piecewiseOffsets).toEqual([{ fromPrintedPage: 3, offset: 3, matchedCount: 2 }]);
    expect(res.nodes.find((n) => n.title.includes('Annex B'))?.page_pdf).toBe(7);

    const outlineEval = evaluateOutline(
      [
        { title: 'Trang đầu', level: 1, pagePdf: 1 },
        { title: 'undefined', level: 1, pagePdf: 2 },
        { title: 'Chương I. Quy định chung', level: 1, pagePdf: 2 },
        { title: 'Mục sâu 8', level: 8, pagePdf: 4 },
        { title: 'A'.repeat(230), level: 2, pagePdf: 6 },
      ],
      7,
      pages
    );
    const combined = combineTocSources({
      pages,
      outlineEval,
      printedToc: { ...res, isUsable: false, nodes: [] },
      bodyHeadings: null,
    });
    expect(combined.nodes.some((n) => n.title === 'Trang đầu' || n.title === 'undefined')).toBe(false);
    expect(combined.nodes.every((n) => n.level <= 6 && n.title.length <= 200)).toBe(true);
    expect(combined.limitsApplied.clampedDepths).toBe(1);
    expect(combined.limitsApplied.truncatedTitles).toBe(1);
  });

  it('6. Độ phủ outline hổng đầu, caption Table/Figure, tiêu đề cột Contents Page & xung đột tiền tố', () => {
    expect(hasPdfEncryptMarker(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Encrypt 5 0 R >>\n%%EOF'))).toBe(true);
    expect(isTableOrFigureCaption('Table A.1 - RAMS lifecycle tasks')).toBe(true);
    expect(isTableOrFigureCaption('Figure B.2: Architecture block diagram')).toBe(true);
    expect(hasConflictingStructuredPrefix('5.6.1 General', 'A.1 General')).toBe(true);
    expect(extractStructuredPrefix('A.1 General')).toBe('num:a.1');

    const pages: PageProfile[] = [
      makeGoodPage(1, [makeRun('TECHNICAL STANDARD COVER', 150, 700, 16, { isBold: true })]),
      makeGoodPage(2, [
        makeRun('Contents Page', 72, 770, 14, { isBold: true }),
        makeRun('1 Scope ................................................ 1', 72, 740, 11),
        makeRun('2 Normative references ................................. 3', 72, 720, 11),
        makeRun('3 Terms and definitions ................................ 6', 72, 700, 11),
        makeRun('4 Requirements ........................................ 10', 72, 680, 11),
        makeRun('5 Lifecycle ........................................... 15', 72, 640, 11),
        makeRun('6 Verification ........................................ 20', 72, 600, 11),
        makeRun('7 Validation .......................................... 25', 72, 580, 11),
        makeRun('Annex A (normative) Checklist ......................... 31', 72, 560, 11),
        makeRun('A.1 General ........................................... 32', 84, 540, 11),
        makeRun('Annex B (informative) Guidance ........................ 36', 72, 520, 11),
        makeRun('Table A.1 - Parameters ................................ 33', 72, 500, 11),
      ]),
    ];
    const headings: Record<number, string> = {
      3: '1 Scope',
      5: '2 Normative references',
      8: '3 Terms and definitions',
      12: '4 Requirements',
      17: '5 Lifecycle',
      22: '6 Verification',
      27: '7 Validation',
      33: 'Annex A (normative) Checklist',
      34: 'A.1 General',
      38: 'Annex B (informative) Guidance',
    };
    for (let pn = 3; pn <= 40; pn++) {
      pages.push(
        makeGoodPage(pn, [
          makeRun(headings[pn] ?? `Body paragraph section content on page ${pn}`, 72, 740, 13, {
            isBold: Boolean(headings[pn]),
          }),
        ])
      );
    }

    const annexOnlyOutline = evaluateOutline(
      [
        { title: 'Annex A (normative) Checklist', level: 1, pagePdf: 33 },
        { title: 'A.1 General', level: 2, pagePdf: 34 },
        { title: 'Annex B (informative) Guidance', level: 1, pagePdf: 38 },
      ],
      40,
      pages
    );
    expect(annexOnlyOutline.isPartial).toBe(true);

    const printed = extractPrintedToc(pages);
    expect(printed.nodes.some((n) => /Table A\.1/i.test(n.title))).toBe(false);
    expect(printed.nodes[0].title).toBe('1 Scope');

    const withPrinted = combineTocSources({
      pages,
      outlineEval: annexOnlyOutline,
      printedToc: printed,
      bodyHeadings: null,
    });
    expect(withPrinted.status).toBe('ok');
    expect(withPrinted.strategy).toBe('printed_toc');
    expect(withPrinted.flags).toContain('outline_incomplete_fallback_printed_toc');

    const cmp = crossCheckNodes(
      [{ title: 'A.1 General', level: 2, page_pdf: 34, sort: 1, source: 'outline', confidence: 0.95 }],
      [
        { title: '5.6.1 General', level: 3, page_pdf: 20, sort: 1, source: 'printed_toc', confidence: 0.95 },
        { title: 'A.1 General', level: 2, page_pdf: 34, sort: 2, source: 'printed_toc', confidence: 0.95 },
      ],
      'printed_toc'
    );
    expect(cmp.matchedExact).toBe(1);
    expect(cmp.missingFromPrimary).toBe(1);
  });

  it('7. Đánh giá chất lượng chữ: không báo nhầm bảng N/A & công thức, giữ needs_ocr cho OCR rác/ảnh thuần', () => {
    const cleanTableNA =
      'Bảng B.3 - Thu thập dữ liệu thời tiết theo điểm vận hành\n' +
      '2010/1/1 1:00 2,5 N/A N/A\n2010/1/1 2:00 2,4 N/A N/A\n' +
      'Tốc độ gió đo theo km/h và m/s tại trạm quan trắc.';
    expect(assessPageTextQuality(cleanTableNA, false).quality).toBe('good');

    const cleanFormulaPage =
      'Phụ lục C (tham khảo) Ví dụ về dải nhiệt độ và công thức tính toán hãm\n' +
      'Bảng C.9 - Công thức tính gia tốc hãm trung bình và lực cản\n' +
      'Gia tốc hãm a b c d e f g h i j k m n p q r s t u v w F = m a + R (kN)\n' +
      'Trong đó nhiệt độ đầu vào T0 và chênh lệch áp suất được tính theo tiêu chuẩn này.';
    expect(assessPageTextQuality(cleanFormulaPage, false).quality).toBe('good');

    const garbledVi =
      'Thong tu nay quy dinh ve quy chuan ky thuat quoc gia cua Bo Giao thong van tai doi voi phuong tien duong sat va ket cau ha tang khong ap dung cho nguoi nuoc ngoai.';
    expect(assessPageTextQuality(garbledVi, true).needsOcr).toBe(true);
    expect(assessPageTextQuality('   ', true).quality).toBe('image_only');
  });

  it('8. body_headings TCVN: đề mục cấu trúc, song ngữ 2 cột, lọc câu văn & chú giải hình, khử số hiệu lặp', () => {
    const p1 = makeGoodPage(1, [
      makeRun('TIÊU CHUẨN QUỐC GIA TCVN 14558-5:2025', 80, 760, 15, { isBold: true }),
      makeRun('PHẦN 5: PHƯƠNG PHÁP THỬ', 120, 720, 14, { isBold: true }),
    ]);
    const p2 = makeGoodPage(2, [
      makeRun('Lời nói đầu', 57, 760, 12, { isBold: true }),
      makeRun('1 Phạm vi áp dụng 1 Scope', 32, 730, 12, { isBold: true }),
      makeRun('2 Tài liệu viện dẫn 2 Normative references', 32, 700, 12, { isBold: true }),
      makeRun('3 Thuật ngữ và định nghĩa 3 Terms and definitions', 32, 670, 12, { isBold: true }),
      makeRun('3.1 Áp dụng tiêu chuẩn 3.1 Application of standards', 32, 640, 11, { isBold: true }),
      makeRun('3.4.6 3.4.6 Đệm điều chỉnh 3.4.6', 32, 610, 11, { isBold: true }),
      makeRun('7.2.3.4 Thiết bị đo lực, theo 6.2.3.7.', 32, 580, 11, { isBold: true }),
      makeRun('CHÚ DẪN:', 57, 540, 11, { isBold: true }),
      makeRun('1 Khung phun nước', 57, 520, 11),
      makeRun('Hình 1 - Sơ đồ bố trí', 180, 490, 11, { isBold: true }),
      makeRun('Thư mục tài liệu tham khảo', 57, 450, 12, { isBold: true }),
    ]);

    const body = extractBodyHeadings([p1, p2]);
    const titles = body.nodes.map((n) => n.title);
    expect(titles).not.toContain('PHẦN 5: PHƯƠNG PHÁP THỬ');
    expect(titles).toContain('Lời nói đầu');
    expect(titles.some((t) => t.startsWith('7.2.3.4'))).toBe(false);
    expect(titles).not.toContain('1 Khung phun nước');
    expect(titles).toContain('3.4.6 Đệm điều chỉnh');
    expect(titles).toContain('Thư mục tài liệu tham khảo');

    const combined = combineTocSources({
      pages: [p1, p2],
      outlineEval: evaluateOutline([], 2, [p1, p2]),
      printedToc: extractPrintedToc([p1, p2]),
      bodyHeadings: body,
    });
    expect(combined.flags).toContain('bilingual_two_column_detected');
  });
});
