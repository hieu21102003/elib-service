import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { QpdfRunner } from '../previews/qpdf.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { extractPdfToc } from './extractor.js';
import type { TocAutoPayload, TocJobStatus, TocStatus } from './types.js';
import { TOC_ALGORITHM_VERSION } from './version.js';

/**
 * Job nền trích xuất mục lục PDF: dùng bảng PostgreSQL `document_file_tocs` làm
 * hàng đợi (`FOR UPDATE OF t2 SKIP LOCKED`), chạy tuần tự 1 file mỗi tick để
 * giữ RAM ổn định khi gặp TCVN lớn. Không bao giờ ghi đè `manual_override` hay
 * `manual_payload` của quản trị viên.
 */

export const TOC_MAX_ATTEMPTS = 2;
const PDF_MIME = 'application/pdf';

export interface TocJobRow {
  file_id: string;
  document_id: string;
  version: number;
  storage_path: string;
  mime_type: string;
  file_size: string | number;
  page_count: number | null;
  attempts: number;
  standard_id: string | null;
}

export type TocLogFn = (message: string) => void;

function truncateError(err: unknown, rootPath?: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (rootPath) {
    message = message.split(rootPath).join('<storage>');
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Hết thời gian xử lý mục lục (${label}, ${ms}ms)`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function saveAutoTocResult(
  pool: pg.Pool,
  fileId: string,
  data: {
    jobStatus: TocJobStatus;
    lastError: string | null;
    autoStatus: TocStatus;
    autoStrategy: string;
    autoFlags: string[];
    autoPayload: TocAutoPayload | null;
    algorithmVersion: string;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO document_file_tocs
       (file_id, job_status, locked_at, last_error, auto_status, auto_strategy,
        auto_flags, auto_payload, algorithm_version, extracted_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6::text[], $7::jsonb, $8, now(), now())
     ON CONFLICT (file_id) DO UPDATE SET
       job_status = EXCLUDED.job_status,
       locked_at = NULL,
       last_error = EXCLUDED.last_error,
       auto_status = EXCLUDED.auto_status,
       auto_strategy = EXCLUDED.auto_strategy,
       auto_flags = EXCLUDED.auto_flags,
       auto_payload = EXCLUDED.auto_payload,
       algorithm_version = EXCLUDED.algorithm_version,
       extracted_at = EXCLUDED.extracted_at,
       updated_at = now()`,
    [
      fileId,
      data.jobStatus,
      data.lastError,
      data.autoStatus,
      data.autoStrategy,
      data.autoFlags,
      data.autoPayload === null ? null : JSON.stringify(data.autoPayload),
      data.algorithmVersion,
    ]
  );
}

/**
 * Xử lý MỘT file PDF để trích xuất mục lục và lưu vào `document_file_tocs`.
 * Không bao giờ ném lỗi ra ngoài — mọi lỗi kỹ thuật đều thành `'failed'` hoặc `'unsupported'`.
 * Tuyệt đối không chạm `manual_override` / `manual_payload`.
 */
export async function processTocFile(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  row: TocJobRow,
  cfg: AppConfig,
  log: TocLogFn = () => undefined,
  opts?: { qpdfRunner?: QpdfRunner }
): Promise<TocStatus> {
  try {
    if (row.mime_type !== PDF_MIME) {
      await saveAutoTocResult(pool, row.file_id, {
        jobStatus: 'unsupported',
        lastError: 'Định dạng không phải PDF',
        autoStatus: 'unsupported',
        autoStrategy: 'unsupported',
        autoFlags: [],
        autoPayload: null,
        algorithmVersion: TOC_ALGORITHM_VERSION,
      });
      return 'unsupported';
    }

    const maxBytes = cfg.tocMaxFileMb * 1024 * 1024;
    const fileSize = Number(row.file_size);
    if (Number.isFinite(fileSize) && fileSize > maxBytes) {
      await saveAutoTocResult(pool, row.file_id, {
        jobStatus: 'done',
        lastError: 'file_too_large',
        autoStatus: 'unsupported',
        autoStrategy: 'unsupported',
        autoFlags: [],
        autoPayload: null,
        algorithmVersion: TOC_ALGORITHM_VERSION,
      });
      log(`toc unsupported (too large): file=${row.file_id} bytes=${fileSize}`);
      return 'unsupported';
    }

    const deadline = Date.now() + cfg.tocFileTimeoutMs;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    const absPath = storage.resolvePath(row.storage_path);

    const payload = await withTimeout(
      extractPdfToc(absPath, {
        qpdfPath: cfg.qpdfPath,
        qpdfTimeoutMs: Math.min(15_000, remainingMs()),
        qpdfRunner: opts?.qpdfRunner,
        createTempPath: () => storage.createTempPath(),
        discardTemp: (tempPath) => storage.discardTemp(tempPath),
      }),
      cfg.tocFileTimeoutMs,
      `file ${row.file_id}`
    );

    if (payload.status === 'unsupported') {
      await saveAutoTocResult(pool, row.file_id, {
        jobStatus: 'done',
        lastError: (payload.reason ?? 'unsupported').slice(0, 1000),
        autoStatus: 'unsupported',
        autoStrategy: payload.strategy,
        autoFlags: payload.flags,
        autoPayload: payload,
        algorithmVersion: payload.algorithmVersion,
      });
      log(`toc unsupported: file=${row.file_id} reason=${payload.reason ?? 'unsupported'}`);
      return 'unsupported';
    }

    const isFailed = payload.status === 'failed';
    await saveAutoTocResult(pool, row.file_id, {
      jobStatus: isFailed ? 'failed' : 'done',
      lastError: isFailed ? (payload.reason ?? 'toc_extraction_failed').slice(0, 1000) : null,
      autoStatus: payload.status,
      autoStrategy: payload.strategy,
      autoFlags: payload.flags,
      autoPayload: payload,
      algorithmVersion: payload.algorithmVersion,
    });

    if (payload.totalPages > 0 && row.page_count === null) {
      await pool.query(
        `UPDATE document_files
         SET page_count = $2
         WHERE id = $1 AND page_count IS NULL`,
        [row.file_id, payload.totalPages]
      );
    }

    log(
      `toc ${payload.status}: file=${row.file_id} strategy=${payload.strategy} nodes=${payload.nodes.length}/${payload.totalPages}p`
    );
    return payload.status;
  } catch (err) {
    const cleanErr = truncateError(err, storage.root);
    await saveAutoTocResult(pool, row.file_id, {
      jobStatus: 'failed',
      lastError: cleanErr,
      autoStatus: 'failed',
      autoStrategy: 'failed',
      autoFlags: [],
      autoPayload: null,
      algorithmVersion: TOC_ALGORITHM_VERSION,
    }).catch(() => undefined);
    log(`toc failed: file=${row.file_id} error=${cleanErr}`);
    return 'failed';
  }
}

/**
 * Nhả các job 'processing' quá hạn:
 * - Quá số lần thử (`attempts >= maxAttempts`) -> đánh `'failed'` dứt điểm.
 * - Còn lượt -> nhả lại `'pending'` để worker xử lý lại.
 */
export async function releaseStaleTocJobs(
  pool: pg.Pool,
  staleMinutes: number,
  maxAttempts = TOC_MAX_ATTEMPTS
): Promise<{ requeued: number; failed: number }> {
  const failedRes = await pool.query(
    `UPDATE document_file_tocs
     SET job_status = 'failed',
         auto_status = 'failed',
         auto_strategy = COALESCE(auto_strategy, 'failed'),
         locked_at = NULL,
         last_error = 'toc_job_stale_timeout',
         updated_at = now()
     WHERE job_status = 'processing'
       AND locked_at IS NOT NULL
       AND locked_at < now() - ($1::int * interval '1 minute')
       AND attempts >= $2::int`,
    [staleMinutes, maxAttempts]
  );

  const requeuedRes = await pool.query(
    `UPDATE document_file_tocs
     SET job_status = 'pending',
         locked_at = NULL,
         updated_at = now()
     WHERE job_status = 'processing'
       AND locked_at IS NOT NULL
       AND locked_at < now() - ($1::int * interval '1 minute')
       AND attempts < $2::int`,
    [staleMinutes, maxAttempts]
  );

  return {
    requeued: requeuedRes.rowCount ?? 0,
    failed: failedRes.rowCount ?? 0,
  };
}

/**
 * Nhận một việc 'pending' nguyên tử (pending -> processing, tăng attempts + 1).
 */
export async function claimNextTocJob(pool: pg.Pool): Promise<TocJobRow | null> {
  const res = await pool.query(
    `UPDATE document_file_tocs t
     SET job_status = 'processing',
         locked_at = now(),
         attempts = t.attempts + 1,
         updated_at = now()
     FROM document_files df
     JOIN documents d ON d.id = df.document_id
     WHERE t.file_id = df.id
       AND t.file_id = (
         SELECT t2.file_id
         FROM document_file_tocs t2
         JOIN document_files df2 ON df2.id = t2.file_id
         WHERE t2.job_status = 'pending'
         ORDER BY df2.created_at ASC
         FOR UPDATE OF t2 SKIP LOCKED
         LIMIT 1
       )
     RETURNING t.file_id, df.document_id, df.version, df.storage_path, df.mime_type,
               df.file_size, df.page_count, t.attempts, d.standard_id`
  );
  return (res.rows[0] as TocJobRow | undefined) ?? null;
}

/** Chạy một lượt: dọn job treo, rồi xử lý tối đa `batchSize` (mặc định 1) file đang chờ. */
export async function runTocJobOnce(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: TocLogFn = () => undefined,
  batchSize = 1,
  opts?: { qpdfRunner?: QpdfRunner }
): Promise<number> {
  await releaseStaleTocJobs(pool, cfg.tocLockStaleMinutes, TOC_MAX_ATTEMPTS).catch((err) => {
    log(`toc: nhả job quá hạn lỗi: ${truncateError(err)}`);
    return { requeued: 0, failed: 0 };
  });

  let processed = 0;
  for (let i = 0; i < batchSize; i++) {
    const row = await claimNextTocJob(pool);
    if (!row) break;
    await processTocFile(pool, storage, row, cfg, log, opts);
    processed++;
  }
  return processed;
}

export interface TocJobHandle {
  stop: () => void;
}

/**
 * Khởi động vòng lặp poll trích xuất mục lục trong tiến trình (mỗi tick xử lý tối đa 1 file).
 */
export function startTocJob(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  log: TocLogFn = () => undefined
): TocJobHandle {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    runTocJobOnce(pool, storage, cfg, log, 1)
      .catch((err) => log(`toc job tick lỗi: ${truncateError(err)}`))
      .finally(() => {
        running = false;
      });
  }, cfg.tocJobIntervalMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
