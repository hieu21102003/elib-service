import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { LocalDiskStorage } from '../storage/local-disk.js';
import { runBackfill, type BackfillArgs } from '../previews/backfill.js';

/**
 * Hồi tố bản xem trước cho các file PDF đã upload trước đây.
 *
 *   npm run backfill:previews [-- --rate 2] [-- --limit 100] [-- --dry-run]
 *
 * Logic nằm ở src/previews/backfill.ts (dùng chung processPreviewFile với job nền).
 */

function parseArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = { rate: 2, limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--rate') args.rate = Number.parseFloat(argv[++i] ?? '');
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] ?? '', 10);
    else if (a.startsWith('--rate=')) args.rate = Number.parseFloat(a.slice('--rate='.length));
    else if (a.startsWith('--limit=')) args.limit = Number.parseInt(a.slice('--limit='.length), 10);
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) args.rate = 2;
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 1)) args.limit = null;
  return args;
}

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
const storage = new LocalDiskStorage(cfg.storageRoot);

try {
  await runBackfill(pool, storage, cfg, parseArgs(process.argv.slice(2)), (m) => console.log(m));
} finally {
  await pool.end();
}
