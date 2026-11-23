import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { LocalDiskStorage } from '../storage/local-disk.js';
import { processPreviewFile, type PreviewFileRow, type PreviewLogFn } from './job.js';

export interface BackfillArgs {
  /** Số file xử lý tối đa mỗi giây. */
  rate: number;
  /** Số file tối đa trong một lượt (null = không giới hạn). */
  limit: number | null;
  /** Chỉ liệt kê, không ghi file/DB. */
  dryRun: boolean;
}

export interface BackfillSummary {
  ready: number;
  failed: number;
  unsupported: number;
  skipped: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hồi tố bản xem trước cho các file có preview_status NULL/'pending'.
 * Idempotent: file đã 'ready'/'failed'/'unsupported' không bị quét lại
 * (muốn thử lại file 'failed' thì đặt về 'pending' thủ công).
 * File gốc thiếu trên đĩa -> 'failed', đi tiếp file sau.
 */
export async function runBackfill(
  pool: pg.Pool,
  storage: LocalDiskStorage,
  cfg: AppConfig,
  args: BackfillArgs,
  log: PreviewLogFn = () => undefined
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { ready: 0, failed: 0, unsupported: 0, skipped: 0 };
  const limitSql =
    args.limit !== null && Number.isFinite(args.limit) && args.limit >= 1
      ? `LIMIT ${Math.floor(args.limit)}`
      : '';
  const res = await pool.query(
    `SELECT id, document_id, version, storage_path, mime_type, file_size, page_count, preview_status
     FROM document_files
     WHERE preview_status IS NULL OR preview_status = 'pending'
     ORDER BY created_at ASC
     ${limitSql}`
  );
  const rows = res.rows as PreviewFileRow[];
  log(
    `backfill:previews — tìm thấy ${rows.length} file cần xử lý` +
      (args.dryRun ? ' (dry-run: không ghi gì)' : '') +
      `, rate=${args.rate} file/giây`
  );

  const rate = Number.isFinite(args.rate) && args.rate > 0 ? args.rate : 2;
  const delayMs = Math.floor(1000 / rate);
  for (const row of rows) {
    if (args.dryRun) {
      log(`[dry-run] sẽ xử lý file=${row.id} mime=${row.mime_type} path=${row.storage_path}`);
      summary.skipped++;
      continue;
    }
    const outcome = await processPreviewFile(pool, storage, row, cfg, log);
    summary[outcome]++;
    if (delayMs > 0) await sleep(delayMs);
  }

  log(
    `Hoàn tất: ready=${summary.ready} failed=${summary.failed} unsupported=${summary.unsupported} bỏ qua=${summary.skipped}`
  );
  return summary;
}
