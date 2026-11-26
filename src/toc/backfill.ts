import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { QpdfRunner } from '../previews/qpdf.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { processTocFile, type TocJobRow, type TocLogFn } from './job.js';
import { TOC_ALGORITHM_VERSION } from './version.js';

export interface TocBackfillArgs {
  /** Nhịp tối đa (số file/giây), luôn xử lý tuần tự 1 file tại một thời điểm. */
  rate: number;
  /** Giới hạn số file xử lý trong một lượt (null = không giới hạn). */
  limit: number | null;
  /** Chỉ liệt kê, không đọc PDF nặng hay ghi DB. */
  dryRun: boolean;
  /** Mặc định true: chỉ xử lý tài liệu gắn tiêu chuẩn (d.standard_id IS NOT NULL). */
  standardsOnly: boolean;
  /** Chạy lại các file đã 'done' nhưng algorithm_version khác bản hiện tại. */
  reextractOutdated: boolean;
  /** Thử lại các file đang có job_status = 'failed'. */
  retryFailed: boolean;
}

export interface TocBackfillSummary {
  total: number;
  ok: number;
  partial: number;
  needs_ocr: number;
  unsupported: number;
  failed: number;
  skipped: number;
  manualOverridePreserved: number;
}

interface BackfillRow extends TocJobRow {
  manual_override?: boolean | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hồi tố / trích xuất lại mục lục PDF theo lô, chạy tuần tự 1 file mỗi lượt.
 * Tuyệt đối không ghi đè `manual_override` hoặc `manual_payload`.
 */
export async function runTocBackfill(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  args: TocBackfillArgs,
  log: TocLogFn = () => undefined,
  opts?: { qpdfRunner?: QpdfRunner }
): Promise<TocBackfillSummary> {
  const summary: TocBackfillSummary = {
    total: 0,
    ok: 0,
    partial: 0,
    needs_ocr: 0,
    unsupported: 0,
    failed: 0,
    skipped: 0,
    manualOverridePreserved: 0,
  };

  const params: unknown[] = [];
  const stateOr: string[] = ['t.file_id IS NULL', "t.job_status = 'pending'"];
  if (args.reextractOutdated) {
    params.push(TOC_ALGORITHM_VERSION);
    stateOr.push(`(t.job_status = 'done' AND t.algorithm_version IS DISTINCT FROM $${params.length})`);
  }
  if (args.retryFailed) {
    stateOr.push("t.job_status = 'failed'");
  }

  const whereParts = ["df.mime_type = 'application/pdf'", `(${stateOr.join(' OR ')})`];
  if (args.standardsOnly) {
    whereParts.push('d.standard_id IS NOT NULL');
  }

  const limitSql =
    args.limit !== null && Number.isFinite(args.limit) && args.limit >= 1
      ? `LIMIT ${Math.floor(args.limit)}`
      : '';

  const res = await pool.query(
    `SELECT df.id AS file_id, df.document_id, df.version, df.storage_path, df.mime_type,
            df.file_size, df.page_count, COALESCE(t.attempts, 0) AS attempts,
            d.standard_id, COALESCE(t.manual_override, false) AS manual_override
     FROM document_files df
     JOIN documents d ON d.id = df.document_id
     LEFT JOIN document_file_tocs t ON t.file_id = df.id
     WHERE ${whereParts.join(' AND ')}
     ORDER BY df.created_at ASC
     ${limitSql}`,
    params
  );

  const rows = res.rows as BackfillRow[];
  summary.total = rows.length;
  log(
    `backfill:toc — tìm thấy ${rows.length} file PDF (${args.standardsOnly ? 'standards-only' : 'all-pdfs'})` +
      (args.reextractOutdated ? ` [reextract != ${TOC_ALGORITHM_VERSION}]` : '') +
      (args.retryFailed ? ' [retry-failed]' : '') +
      (args.dryRun ? ' (dry-run: không ghi gì)' : '') +
      `, rate=${args.rate} file/giây`
  );

  const rate = Number.isFinite(args.rate) && args.rate > 0 ? args.rate : 1;
  const delayMs = Math.floor(1000 / rate);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (args.dryRun) {
      log(
        `[dry-run ${i + 1}/${rows.length}] file=${row.file_id} doc=${row.document_id} v=${row.version}` +
          (row.manual_override ? ' (manual_override preserved)' : '')
      );
      summary.skipped++;
      if (row.manual_override) summary.manualOverridePreserved++;
      continue;
    }

    const status = await processTocFile(pool, storage, row, cfg, log, opts);
    summary[status]++;
    if (row.manual_override) {
      summary.manualOverridePreserved++;
    }
    if (delayMs > 0 && i < rows.length - 1) {
      await sleep(delayMs);
    }
  }

  log(
    `Hoàn tất backfill:toc (${TOC_ALGORITHM_VERSION}): total=${summary.total} ok=${summary.ok} partial=${summary.partial} needs_ocr=${summary.needs_ocr} unsupported=${summary.unsupported} failed=${summary.failed} skipped=${summary.skipped} manualPreserved=${summary.manualOverridePreserved}`
  );
  return summary;
}
