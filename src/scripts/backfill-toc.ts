import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { LocalDiskStorage } from '../storage/local-disk.js';
import { runTocBackfill, type TocBackfillArgs } from '../toc/backfill.js';

/**
 * Hồi tố / trích xuất lại mục lục PDF:
 *
 *   npm run backfill:toc [-- --rate 1] [-- --limit 100] [-- --dry-run]
 *                        [-- --standards-only] [-- --all-pdfs]
 *                        [-- --reextract-outdated] [-- --retry-failed]
 *
 * Logic nằm ở src/toc/backfill.ts (dùng chung processTocFile với job nền).
 */

function parseArgs(argv: string[]): TocBackfillArgs {
  const args: TocBackfillArgs = {
    rate: 1,
    limit: null,
    dryRun: false,
    standardsOnly: true,
    reextractOutdated: false,
    retryFailed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--standards-only') args.standardsOnly = true;
    else if (a === '--all-pdfs') args.standardsOnly = false;
    else if (a === '--reextract-outdated') args.reextractOutdated = true;
    else if (a === '--retry-failed') args.retryFailed = true;
    else if (a === '--rate') args.rate = Number.parseFloat(argv[++i] ?? '');
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] ?? '', 10);
    else if (a.startsWith('--rate=')) args.rate = Number.parseFloat(a.slice('--rate='.length));
    else if (a.startsWith('--limit=')) args.limit = Number.parseInt(a.slice('--limit='.length), 10);
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) args.rate = 1;
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 1)) args.limit = null;
  return args;
}

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
const storage = new LocalDiskStorage(cfg.storageRoot);

try {
  await runTocBackfill(pool, storage, cfg, parseArgs(process.argv.slice(2)), (m) => console.log(m));
} finally {
  await pool.end();
}
