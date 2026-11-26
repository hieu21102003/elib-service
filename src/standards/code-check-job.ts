import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { hasPdfEncryptMarker, isEncryptedPdfError } from '../previews/pdf-preview.js';
import { extractPdfTextFromFirstPages, pdfTextContainsCode } from '../previews/pdf-text.js';
import { decryptPdfWithQpdf, type QpdfRunner } from '../previews/qpdf.js';
import { lightNormalizeCode } from './light-normalize.js';

/**
 * Job nền kiểm tra mã chuẩn trong PDF: sau khi upload file tiêu chuẩn,
 * trích chữ vài trang đầu và kiểm tra mã chuẩn (đã chuẩn hóa nhẹ) có
 * xuất hiện hay không. Kết quả chỉ là CẢNH BÁO (code_check_status =
 * 'not_found') — không bao giờ chặn tài liệu.
 *
 * Cùng khung với job preview: hàng đợi là cột code_check_status trên
 * document_files, nhận việc nguyên tử bằng UPDATE + FOR UPDATE SKIP
 * LOCKED, việc 'processing' quá hạn được nhả lại thành 'pending'.
 * PDF mã hóa: giải mã bằng qpdf (user password rỗng) sang thư mục tạm,
 * trích chữ xong xóa ngay.
 */

export interface CodeCheckFileRow {
  id: string;
  document_id: string;
  storage_path: string;
  mime_type: string;
  file_size: string | number;
}

export interface CodeCheckStandardInfo {
  normalized_code: string;
  code_key_raw: string | null;
  base_key: string;
  code_display: string;
}

export type CodeCheckOutcome = 'found' | 'not_found' | 'failed' | 'skipped';
export type CodeCheckLogFn = (message: string) => void;

const PDF_MIME = 'application/pdf';

function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 1000);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Hết thời gian xử lý (${label}, ${ms}ms)`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishCheck(
  pool: pg.Pool,
  fileId: string,
  status: 'found' | 'not_found' | 'failed',
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE document_files
     SET code_check_status = $2, code_check_error = $3,
         code_checked_at = now(), code_check_locked_at = NULL
     WHERE id = $1`,
    [fileId, status, error]
  );
}

/** Các dạng mã đem so với chữ trong PDF: khóa chuẩn hóa, khóa gốc, khóa không năm, mã hiển thị + biến thể ':' -> '-'. */
export function codeCandidatesFor(info: CodeCheckStandardInfo): string[] {
  const raw: Array<string | null> = [
    info.normalized_code,
    info.code_key_raw,
    info.base_key,
    lightNormalizeCode(info.code_display)?.normalized_code ?? null
  ];
  const out = new Set<string>();
  for (const candidate of raw) {
    if (!candidate) continue;
    out.add(candidate);
    if (candidate.includes(':')) out.add(candidate.replace(/:/g, '-'));
  }
  return [...out];
}

/**
 * Xử lý MỘT file: trích chữ vài trang đầu, so mã, ghi kết quả.
 * Không bao giờ ném lỗi ra ngoài — lỗi thành 'failed' kèm lý do.
 */
export async function processCodeCheckFile(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  row: CodeCheckFileRow,
  info: CodeCheckStandardInfo,
  cfg: AppConfig,
  log: CodeCheckLogFn = () => undefined,
  qpdfOpts?: { runner?: QpdfRunner }
): Promise<CodeCheckOutcome> {
  try {
    if (row.mime_type !== PDF_MIME) {
      await finishCheck(pool, row.id, 'failed', 'Định dạng không phải PDF — không kiểm tra được mã');
      return 'failed';
    }
    const maxBytes = cfg.previewMaxFileMb * 1024 * 1024;
    const fileSize = Number(row.file_size);
    if (Number.isFinite(fileSize) && fileSize > maxBytes) {
      throw new Error(`File vượt quá giới hạn xử lý kiểm tra mã (${cfg.previewMaxFileMb} MB)`);
    }

    const deadline = Date.now() + cfg.codeCheckTimeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());

    const found = await withTimeout(
      (async () => {
        const original = await storage.readBytes(row.storage_path, maxBytes);
        let text: string;
        try {
          text = await extractPdfTextFromFirstPages(original, cfg.codeCheckPages);
        } catch (err) {
          if (!isEncryptedPdfError(err) && !hasPdfEncryptMarker(original)) throw err;
          // PDF mã hóa: giải mã bằng qpdf (password rỗng) sang file tạm,
          // trích chữ xong xóa ngay — bản giải mã không bao giờ được lưu lại.
          const tempOutPath = await storage.createTempPath();
          try {
            await decryptPdfWithQpdf(storage.resolvePath(row.storage_path), tempOutPath, {
              qpdfPath: cfg.qpdfPath,
              timeoutMs: remainingMs(),
              runner: qpdfOpts?.runner
            });
            const { readFile } = await import('node:fs/promises');
            const decrypted = await readFile(tempOutPath);
            text = await extractPdfTextFromFirstPages(decrypted, cfg.codeCheckPages);
          } finally {
            await storage.discardTemp(tempOutPath);
          }
        }
        return pdfTextContainsCode(text, codeCandidatesFor(info));
      })(),
      cfg.codeCheckTimeoutMs,
      `code-check file ${row.id}`
    );

    await finishCheck(pool, row.id, found ? 'found' : 'not_found', null);
    log(
      `code-check ${found ? 'found' : 'not_found'}: file=${row.id} code=${info.normalized_code}`
    );
    return found ? 'found' : 'not_found';
  } catch (err) {
    await finishCheck(pool, row.id, 'failed', truncateError(err)).catch(() => undefined);
    log(`code-check failed: file=${row.id} error=${truncateError(err)}`);
    return 'failed';
  }
}

/** Nhả các job kiểm tra mã 'processing' quá hạn về 'pending'. */
export async function releaseStaleCodeCheckJobs(
  pool: pg.Pool,
  staleMinutes: number
): Promise<number> {
  const res = await pool.query(
    `UPDATE document_files
     SET code_check_status = 'pending', code_check_locked_at = NULL
     WHERE code_check_status = 'processing'
       AND code_check_locked_at IS NOT NULL
       AND code_check_locked_at < now() - ($1::int * interval '1 minute')`,
    [staleMinutes]
  );
  return res.rowCount ?? 0;
}

/**
 * Nhận một việc kiểm tra mã 'pending' một cách nguyên tử (pending ->
 * processing). Chỉ nhận file thuộc tài liệu đã gắn tiêu chuẩn.
 */
export async function claimNextCodeCheckJob(pool: pg.Pool): Promise<CodeCheckFileRow | null> {
  const res = await pool.query(
    `UPDATE document_files
     SET code_check_status = 'processing', code_check_locked_at = now()
     WHERE id = (
       SELECT df.id FROM document_files df
       JOIN documents d ON d.id = df.document_id
       WHERE df.code_check_status = 'pending' AND d.standard_id IS NOT NULL
       ORDER BY df.created_at ASC
       FOR UPDATE OF df SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, document_id, storage_path, mime_type, file_size`
  );
  return (res.rows[0] as CodeCheckFileRow | undefined) ?? null;
}

/** Lấy thông tin mã của tiêu chuẩn gắn với tài liệu (cho job kiểm tra). */
export async function loadStandardInfoForDocument(
  pool: pg.Pool,
  documentId: string
): Promise<CodeCheckStandardInfo | null> {
  const res = await pool.query(
    `SELECT s.normalized_code, s.code_key_raw, s.base_key, s.code_display
     FROM documents d JOIN standards s ON s.id = d.standard_id
     WHERE d.id = $1`,
    [documentId]
  );
  return (res.rows[0] as CodeCheckStandardInfo | undefined) ?? null;
}

/** Chạy một lượt: nhả job quá hạn, rồi xử lý tối đa `batchSize` file đang chờ. */
export async function runCodeCheckJobOnce(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: CodeCheckLogFn = () => undefined,
  batchSize = 1
): Promise<number> {
  await releaseStaleCodeCheckJobs(pool, cfg.codeCheckLockStaleMinutes).catch((err) => {
    log(`code-check: nhả job quá hạn lỗi: ${truncateError(err)}`);
    return 0;
  });
  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const row = await claimNextCodeCheckJob(pool);
    if (!row) break;
    const info = await loadStandardInfoForDocument(pool, row.document_id);
    if (!info) {
      await finishCheck(pool, row.id, 'failed', 'Tài liệu không còn gắn tiêu chuẩn').catch(
        () => undefined
      );
    } else {
      await processCodeCheckFile(pool, storage, row, info, cfg, log);
    }
    processed++;
  }
  return processed;
}

export interface CodeCheckJobHandle {
  stop: () => void;
}

/** Khởi động vòng lặp poll kiểm tra mã trong tiến trình (như job preview). */
export function startCodeCheckJob(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: CodeCheckLogFn = () => undefined
): CodeCheckJobHandle {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    runCodeCheckJobOnce(pool, storage, cfg, log, 1)
      .catch((err) => log(`code-check job tick lỗi: ${truncateError(err)}`))
      .finally(() => {
        running = false;
      });
  }, cfg.codeCheckJobIntervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
