import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Xử lý PDF mã hóa (vd RC4 với user password rỗng, owner chặn sửa/ghép trang)
 * bằng tiến trình con `qpdf`:
 * - KHÔNG dùng shell string (spawn với mảng tham số, `shell: false`).
 * - Có timeout rõ ràng (kill SIGKILL khi quá hạn).
 * - Chỉ truyền user password rỗng (`--password=`); tuyệt đối không đoán mật khẩu.
 * - Cắt trang bằng `qpdf --empty --pages <in> --password= 1-N -- <out>` để
 *   không mang theo metadata, outline hay attachment của bản gốc.
 */

const MAX_OUTPUT_BYTES = 64 * 1024;
const PDF_HEADER = '%PDF-';

export class QpdfPasswordRequiredError extends Error {
  constructor(message = 'PDF yêu cầu mật khẩu mở — không hỗ trợ tạo bản xem trước') {
    super(message);
    this.name = 'QpdfPasswordRequiredError';
  }
}

export class QpdfNotAvailableError extends Error {
  constructor(message = 'PDF được mã hóa nhưng máy chủ chưa cài qpdf để tạo bản xem trước') {
    super(message);
    this.name = 'QpdfNotAvailableError';
  }
}

export class QpdfTimeoutError extends Error {
  constructor(message = 'Hết thời gian xử lý qpdf khi tạo bản xem trước PDF mã hóa') {
    super(message);
    this.name = 'QpdfTimeoutError';
  }
}

export interface QpdfExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type QpdfRunner = (bin: string, args: string[], timeoutMs: number) => Promise<QpdfExecResult>;

export interface QpdfOptions {
  qpdfPath?: string;
  timeoutMs: number;
  runner?: QpdfRunner;
}

function assertSafeAbsPath(filePath: string, label: string): void {
  if (!filePath || !path.isAbsolute(filePath) || filePath.startsWith('-')) {
    throw new Error(`Đường dẫn ${label} không hợp lệ để truyền cho qpdf`);
  }
}

function isInvalidPasswordStderr(stderr: string): boolean {
  return /invalid password/i.test(stderr);
}

function sanitizeStderr(stderr: string, paths: string[]): string {
  let clean = stderr;
  for (const p of paths) {
    if (p) clean = clean.split(p).join('<file>');
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function appendLimited(chunks: Buffer[], totalRef: { bytes: number }, chunk: Buffer): void {
  if (totalRef.bytes >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - totalRef.bytes;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(slice);
  totalRef.bytes += slice.length;
}

/**
 * Gọi tiến trình con qpdf không qua shell (`shell: false`), có timeout và giới hạn
 * bộ đệm stdout/stderr tối đa 64 KB mỗi luồng.
 */
export async function spawnQpdf(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<QpdfExecResult> {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 1;
  return await new Promise<QpdfExecResult>((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutSize = { bytes: 0 };
    const stderrSize = { bytes: 0 };

    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Tiến trình có thể đã thoát ngay trước khi kill.
      }
      reject(new QpdfTimeoutError());
    }, effectiveTimeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      appendLimited(stdoutChunks, stdoutSize, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendLimited(stderrChunks, stderrSize, chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new QpdfNotAvailableError());
        return;
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}

async function assertValidPdfFile(filePath: string): Promise<void> {
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile() || st.size < PDF_HEADER.length) {
    throw new Error('File xem trước qpdf tạo ra không hợp lệ hoặc rỗng');
  }
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(PDF_HEADER.length);
    const { bytesRead } = await fh.read(buf, 0, PDF_HEADER.length, 0);
    if (bytesRead < PDF_HEADER.length || buf.toString('latin1') !== PDF_HEADER) {
      throw new Error('File xem trước qpdf tạo ra không đúng định dạng PDF');
    }
  } finally {
    await fh.close();
  }
}

/**
 * Đếm số trang PDF mã hóa qua `qpdf --password= --show-npages <inputPath>`.
 * Chấp nhận exit code 0 và 3 (qpdf trả 3 khi có warning không nghiêm trọng).
 */
export async function countPdfPagesWithQpdf(
  inputPath: string,
  opts: QpdfOptions
): Promise<number> {
  assertSafeAbsPath(inputPath, 'inputPath');
  const bin = opts.qpdfPath?.trim() || 'qpdf';
  const runner = opts.runner ?? spawnQpdf;
  const { exitCode, stderr, stdout } = await runner(
    bin,
    ['--password=', '--show-npages', inputPath],
    opts.timeoutMs
  );
  if (exitCode !== 0 && exitCode !== 3) {
    if (isInvalidPasswordStderr(stderr)) {
      throw new QpdfPasswordRequiredError();
    }
    const detail = sanitizeStderr(stderr, [inputPath]);
    throw new Error(
      `Không xử lý được PDF mã hóa bằng qpdf (đếm trang, mã ${exitCode})${detail ? `: ${detail}` : ''}`
    );
  }
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`qpdf trả về số trang không hợp lệ: "${trimmed.slice(0, 50)}"`);
  }
  const pages = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new Error(`qpdf trả về số trang không hợp lệ: ${pages}`);
  }
  return pages;
}

/**
 * Giải mã (chỉ với user password rỗng) và cắt trang `1..previewPages` sang
 * `outputTempPath` bằng `qpdf --empty --pages <in> --password= 1-N -- <out>`.
 * File kết quả bắt buộc là PDF hợp lệ (> 0 byte, bắt đầu bằng `%PDF-`).
 */
export async function extractPreviewPagesWithQpdf(
  inputPath: string,
  previewPages: number,
  outputTempPath: string,
  opts: QpdfOptions
): Promise<void> {
  if (!Number.isInteger(previewPages) || previewPages < 1) {
    throw new Error(`Số trang xem trước không hợp lệ: ${previewPages}`);
  }
  assertSafeAbsPath(inputPath, 'inputPath');
  assertSafeAbsPath(outputTempPath, 'outputTempPath');
  const bin = opts.qpdfPath?.trim() || 'qpdf';
  const runner = opts.runner ?? spawnQpdf;
  const { exitCode, stderr } = await runner(
    bin,
    ['--empty', '--pages', inputPath, '--password=', `1-${previewPages}`, '--', outputTempPath],
    opts.timeoutMs
  );
  if (exitCode !== 0 && exitCode !== 3) {
    if (isInvalidPasswordStderr(stderr)) {
      throw new QpdfPasswordRequiredError();
    }
    const detail = sanitizeStderr(stderr, [inputPath, outputTempPath]);
    throw new Error(
      `Không xử lý được PDF mã hóa bằng qpdf (cắt trang, mã ${exitCode})${detail ? `: ${detail}` : ''}`
    );
  }
  await assertValidPdfFile(outputTempPath);
}
