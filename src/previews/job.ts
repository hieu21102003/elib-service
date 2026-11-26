import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { computePreviewPages } from './page-count.js';
import {
  buildPreviewPdf,
  countPdfPages,
  hasPdfEncryptMarker,
  isEncryptedPdfError
} from './pdf-preview.js';
import {
  countPdfPagesWithQpdf,
  extractPreviewPagesWithQpdf,
  type QpdfRunner
} from './qpdf.js';

/**
 * Job nền tạo bản xem trước: chạy trong tiến trình elib, vòng lặp poll,
 * bảng document_files làm hàng đợi (preview_status). Không dùng Redis.
 *
 * Nhận việc nguyên tử bằng một UPDATE duy nhất với subquery
 * `FOR UPDATE SKIP LOCKED` — hai worker không bao giờ xử lý đúp một file.
 * Việc 'processing' quá hạn (preview_locked_at cũ hơn ngưỡng) được nhả
 * lại thành 'pending' ở đầu mỗi lượt.
 */

export interface PreviewFileRow {
  id: string;
  document_id: string;
  version: number;
  storage_path: string;
  mime_type: string;
  file_size: string | number;
  page_count: number | null;
  preview_status: string | null;
}

export type PreviewLogFn = (message: string) => void;

export type PreviewOutcome = 'ready' | 'failed' | 'unsupported' | 'skipped';

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

async function markFailed(pool: pg.Pool, fileId: string, err: unknown): Promise<void> {
  await pool.query(
    `UPDATE document_files
     SET preview_status = 'failed', preview_error = $2, preview_locked_at = NULL
     WHERE id = $1`,
    [fileId, truncateError(err)]
  );
}

async function markUnsupported(pool: pg.Pool, fileId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE document_files
     SET preview_status = 'unsupported', preview_error = $2, preview_locked_at = NULL
     WHERE id = $1`,
    [fileId, reason]
  );
}

/**
 * Xử lý MỘT file: đếm trang, tính số trang xem trước, cắt PDF, ghi file
 * xem trước, cập nhật DB. Hàm này được job poll và script backfill dùng chung.
 * Không bao giờ ném lỗi ra ngoài — mọi lỗi đều thành 'failed'/'unsupported'.
 */
export async function processPreviewFile(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  row: PreviewFileRow,
  cfg: AppConfig,
  log: PreviewLogFn = () => undefined,
  qpdfOpts?: { runner?: QpdfRunner }
): Promise<PreviewOutcome> {
  try {
    if (row.mime_type !== PDF_MIME) {
      await markUnsupported(pool, row.id, 'Định dạng không phải PDF — giai đoạn này chưa hỗ trợ xem trước');
      return 'unsupported';
    }

    const maxBytes = cfg.previewMaxFileMb * 1024 * 1024;
    const fileSize = Number(row.file_size);
    if (Number.isFinite(fileSize) && fileSize > maxBytes) {
      throw new Error(
        `File vượt quá giới hạn xử lý xem trước (${cfg.previewMaxFileMb} MB)`
      );
    }

    const deadline = Date.now() + cfg.previewFileTimeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());

    const result = await withTimeout(
      (async () => {
        const original = await storage.readBytes(row.storage_path, maxBytes);
        let totalPages: number;
        let usedQpdf = false;
        let originalAbsPath: string | null = null;
        try {
          totalPages = await countPdfPages(original);
        } catch (err) {
          if (isEncryptedPdfError(err) || hasPdfEncryptMarker(original)) {
            usedQpdf = true;
            originalAbsPath = storage.resolvePath(row.storage_path);
            totalPages = await countPdfPagesWithQpdf(originalAbsPath, {
              qpdfPath: cfg.qpdfPath,
              timeoutMs: remainingMs(),
              runner: qpdfOpts?.runner
            });
          } else {
            throw err;
          }
        }

        const previewPages = computePreviewPages(totalPages, {
          ratio: cfg.previewRatio,
          maxPages: cfg.previewMaxPages
        });
        if (previewPages === null) {
          return { totalPages, previewPages: null, previewPath: null as string | null };
        }

        const previewPath = storage.buildPreviewPath(row.document_id, row.version);
        if (!usedQpdf) {
          const built = await buildPreviewPdf(original, previewPages);
          await storage.saveBytes(built.bytes, previewPath);
          return { totalPages, previewPages, previewPath };
        }

        const tempOutPath = await storage.createTempPath();
        try {
          await extractPreviewPagesWithQpdf(originalAbsPath!, previewPages, tempOutPath, {
            qpdfPath: cfg.qpdfPath,
            timeoutMs: remainingMs(),
            runner: qpdfOpts?.runner
          });
          await storage.commitTemp(tempOutPath, previewPath);
        } catch (qErr) {
          await storage.discardTemp(tempOutPath);
          throw qErr;
        }
        return { totalPages, previewPages, previewPath };
      })(),
      cfg.previewFileTimeoutMs,
      `file ${row.id}`
    );

    if (result.previewPages === null || result.previewPath === null) {
      // Tài liệu quá ngắn: bản xem trước sẽ bằng toàn bộ nội dung.
      await pool.query(
        `UPDATE document_files
         SET page_count = $2, preview_status = 'unsupported',
             preview_error = 'Tài liệu quá ngắn để tạo bản xem trước giới hạn trang',
             preview_locked_at = NULL
         WHERE id = $1`,
        [row.id, result.totalPages]
      );
      return 'unsupported';
    }

    await pool.query(
      `UPDATE document_files
       SET page_count = $2, preview_pages = $3, preview_path = $4,
           preview_status = 'ready', preview_error = NULL, preview_locked_at = NULL
       WHERE id = $1`,
      [row.id, result.totalPages, result.previewPages, result.previewPath]
    );
    log(`preview ready: file=${row.id} pages=${result.previewPages}/${result.totalPages}`);
    return 'ready';
  } catch (err) {
    await markFailed(pool, row.id, err).catch(() => undefined);
    log(`preview failed: file=${row.id} error=${truncateError(err)}`);
    return 'failed';
  }
}

/** Nhả các job 'processing' quá hạn về 'pending'. Trả về số dòng đã nhả. */
export async function releaseStaleJobs(
  pool: pg.Pool,
  staleMinutes: number
): Promise<number> {
  const res = await pool.query(
    `UPDATE document_files
     SET preview_status = 'pending', preview_locked_at = NULL
     WHERE preview_status = 'processing'
       AND preview_locked_at IS NOT NULL
       AND preview_locked_at < now() - ($1::int * interval '1 minute')`,
    [staleMinutes]
  );
  return res.rowCount ?? 0;
}

/**
 * Nhận một việc 'pending' một cách nguyên tử (pending -> processing).
 * Trả về dòng đã nhận, hoặc null nếu hàng đợi trống.
 */
export async function claimNextPreviewJob(pool: pg.Pool): Promise<PreviewFileRow | null> {
  const res = await pool.query(
    `UPDATE document_files
     SET preview_status = 'processing', preview_locked_at = now()
     WHERE id = (
       SELECT id FROM document_files
       WHERE preview_status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, document_id, version, storage_path, mime_type, file_size, page_count, preview_status`
  );
  return (res.rows[0] as PreviewFileRow | undefined) ?? null;
}

/** Chạy một lượt: nhả job quá hạn, rồi xử lý tối đa `batchSize` file đang chờ. */
export async function runPreviewJobOnce(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: PreviewLogFn = () => undefined,
  batchSize = 1
): Promise<number> {
  await releaseStaleJobs(pool, cfg.previewLockStaleMinutes).catch((err) => {
    log(`preview: nhả job quá hạn lỗi: ${truncateError(err)}`);
    return 0;
  });
  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const row = await claimNextPreviewJob(pool);
    if (!row) break;
    await processPreviewFile(pool, storage, row, cfg, log);
    processed++;
  }
  return processed;
}

export interface PreviewJobHandle {
  stop: () => void;
}

/**
 * Khởi động vòng lặp poll trong tiến trình. Mỗi tick xử lý 1 file để không
 * chiếm CPU của luồng API. Lỗi ở một tick không làm dừng vòng lặp.
 */
export function startPreviewJob(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: PreviewLogFn = () => undefined
): PreviewJobHandle {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    runPreviewJobOnce(pool, storage, cfg, log, 1)
      .catch((err) => log(`preview job tick lỗi: ${truncateError(err)}`))
      .finally(() => {
        running = false;
      });
  }, cfg.previewJobIntervalMs);
  // Không giữ tiến trình sống chỉ vì timer này (server vẫn có listener riêng).
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
