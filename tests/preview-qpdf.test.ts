import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { hasPdfEncryptMarker, isEncryptedPdfError } from '../src/previews/pdf-preview.js';
import {
  QpdfNotAvailableError,
  QpdfPasswordRequiredError,
  QpdfTimeoutError,
  countPdfPagesWithQpdf,
  extractPreviewPagesWithQpdf,
  spawnQpdf,
  type QpdfRunner
} from '../src/previews/qpdf.js';
import {
  createMockQpdfRunner,
  makePlainMinimalPdf,
  makeRc4EncryptedPdf
} from './helpers/encrypted-pdf.js';

describe('helper PDF mã hóa RC4 + nhận diện lỗi mã hóa pdf-lib', () => {
  it('makePlainMinimalPdf tạo PDF 1.4 hợp lệ đọc được bằng pdf-lib (kèm Outlines/Names/Info)', async () => {
    const bytes = makePlainMinimalPdf({ pageCount: 5 });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(5);
    expect(doc.getTitle()).toBe('Tieu de bi mat cua ban goc');
    expect(doc.getAuthor()).toBe('Tac gia bi mat');
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeDefined();
    expect(doc.catalog.get(PDFName.of('Names'))).toBeDefined();
  });

  it('makeRc4EncryptedPdf khiến pdf-lib từ chối và isEncryptedPdfError + hasPdfEncryptMarker nhận diện đúng', async () => {
    for (const userPassword of ['', 'matkhau-mo-file']) {
      const bytes = makeRc4EncryptedPdf({ pageCount: 6, userPassword });
      expect(hasPdfEncryptMarker(bytes)).toBe(true);
      let caught: unknown;
      try {
        await PDFDocument.load(bytes, { ignoreEncryption: false });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isEncryptedPdfError(caught)).toBe(true);
    }
    expect(hasPdfEncryptMarker(makePlainMinimalPdf({ pageCount: 3 }))).toBe(false);
    expect(isEncryptedPdfError(new Error('PDF hỏng không đọc được'))).toBe(false);
  });
});

describe('spawnQpdf — tiến trình con không qua shell + timeout + xử lý lỗi', () => {
  it('shell: false — ký tự shell đặc biệt trong tham số được truyền nguyên văn, không thực thi shell', async () => {
    const marker = path.join(tmpdir(), `should-not-exist-${Date.now()}`);
    const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', `; touch ${marker}`, '$(id)', 'a b'];
    const res = await spawnQpdf(process.execPath, args, 5000);
    expect(res.exitCode).toBe(0);
    const received = JSON.parse(res.stdout) as string[];
    expect(received).toEqual(['; touch ' + marker, '$(id)', 'a b']);
  });

  it('quá timeout -> kill tiến trình con và ném QpdfTimeoutError', async () => {
    await expect(
      spawnQpdf(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 80)
    ).rejects.toBeInstanceOf(QpdfTimeoutError);
  });

  it('binary không tồn tại (ENOENT) -> ném QpdfNotAvailableError', async () => {
    await expect(
      spawnQpdf('definitely-missing-qpdf-binary-99999', ['--version'], 2000)
    ).rejects.toBeInstanceOf(QpdfNotAvailableError);
  });

  it('trả đúng exitCode (0, 2, 3), stdout và stderr', async () => {
    for (const code of [0, 2, 3]) {
      const res = await spawnQpdf(
        process.execPath,
        ['-e', `process.stdout.write('ok-${code}'); process.stderr.write('err-${code}'); process.exit(${code})`],
        5000
      );
      expect(res.exitCode).toBe(code);
      expect(res.stdout).toBe(`ok-${code}`);
      expect(res.stderr).toBe(`err-${code}`);
    }
  });
});

describe('countPdfPagesWithQpdf + extractPreviewPagesWithQpdf', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'elib-qpdf-unit-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('đếm trang và cắt trang với đúng tham số, chấp nhận exit code 0 và 3', async () => {
    const inPath = path.join(dir, 'in.pdf');
    const outPath = path.join(dir, 'out.pdf');
    await writeFile(inPath, makeRc4EncryptedPdf({ pageCount: 10, userPassword: '' }));

    const mock = createMockQpdfRunner({ successExitCode: 3 });
    const pages = await countPdfPagesWithQpdf(inPath, { timeoutMs: 5000, runner: mock.runner });
    expect(pages).toBe(10);

    await extractPreviewPagesWithQpdf(inPath, 2, outPath, { timeoutMs: 5000, runner: mock.runner });
    expect(mock.calls).toEqual([
      { bin: 'qpdf', args: ['--password=', '--show-npages', inPath], timeoutMs: 5000 },
      { bin: 'qpdf', args: ['--empty', '--pages', inPath, '--password=', '1-2', '--', outPath], timeoutMs: 5000 }
    ]);
  });

  it('file cần mật khẩu mở -> QpdfPasswordRequiredError (không đoán mật khẩu, chỉ gọi 1 lần)', async () => {
    const inPath = path.join(dir, 'locked.pdf');
    await writeFile(inPath, makeRc4EncryptedPdf({ pageCount: 8, userPassword: 'secret' }));
    const mock = createMockQpdfRunner();

    await expect(
      countPdfPagesWithQpdf(inPath, { timeoutMs: 5000, runner: mock.runner })
    ).rejects.toBeInstanceOf(QpdfPasswordRequiredError);
    expect(mock.calls).toHaveLength(1);
  });

  it('chặn đường dẫn không tuyệt đối hoặc bắt đầu bằng "-"', async () => {
    const mock = createMockQpdfRunner();
    await expect(countPdfPagesWithQpdf('relative.pdf', { timeoutMs: 1000, runner: mock.runner })).rejects.toThrow();
    await expect(countPdfPagesWithQpdf('-flag.pdf', { timeoutMs: 1000, runner: mock.runner })).rejects.toThrow();
    const validIn = path.join(dir, 'a.pdf');
    await expect(extractPreviewPagesWithQpdf(validIn, 1, 'relative-out.pdf', { timeoutMs: 1000, runner: mock.runner })).rejects.toThrow();
  });

  it('xác thực file đầu ra: rỗng hoặc không bắt đầu bằng %PDF- -> lỗi; stderr ẩn đường dẫn tuyệt đối', async () => {
    const inPath = path.join(dir, 'in.pdf');
    const outPath = path.join(dir, 'out.pdf');

    const badOutputRunner: QpdfRunner = async () => {
      await writeFile(outPath, 'NOT-A-PDF');
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    };
    await expect(
      extractPreviewPagesWithQpdf(inPath, 2, outPath, { timeoutMs: 5000, runner: badOutputRunner })
    ).rejects.toThrow(/định dạng PDF/);

    const errRunner: QpdfRunner = async () => ({
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: `qpdf: ${inPath}: damaged PDF stream`
    });
    await expect(
      countPdfPagesWithQpdf(inPath, { timeoutMs: 5000, runner: errRunner })
    ).rejects.toThrow(/^((?!in\.pdf).)*damaged PDF stream/);
  });
});
