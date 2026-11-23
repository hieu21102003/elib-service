import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { loadConfig, type AppConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import {
  claimNextPreviewJob,
  processPreviewFile,
  releaseStaleJobs,
  runPreviewJobOnce,
  type PreviewFileRow
} from '../src/previews/job.js';
import { runBackfill } from '../src/previews/backfill.js';
import { readFileSync } from 'node:fs';
import { createPool } from '../src/db.js';

const hasDb = !!process.env.DATABASE_URL && process.env.ELIB_RUN_DB_TESTS === '1';

/**
 * FakeDb tối thiểu cho bảng document_files: mô phỏng đúng các câu SQL mà
 * job/backfill dùng. Claim được thực hiện đồng bộ trong query() nên hai
 * lời gọi claim đồng thời không thể nhận cùng một dòng — mô phỏng tính
 * nguyên tử của UPDATE ... FOR UPDATE SKIP LOCKED trên PostgreSQL thật.
 */
class FakePreviewDb {
  files = new Map<string, Record<string, unknown>>();

  addFile(row: Record<string, unknown>): void {
    this.files.set(String(row.id), row);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith("UPDATE document_files SET preview_status = 'processing'")) {
      const pending = [...this.files.values()]
        .filter((f) => f.preview_status === 'pending')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (pending.length === 0) return { rows: [], rowCount: 0 };
      const row = pending[0];
      row.preview_status = 'processing';
      row.preview_locked_at = new Date();
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (s.startsWith("UPDATE document_files SET preview_status = 'pending'")) {
      const staleMinutes = Number(params[0]);
      const cutoff = Date.now() - staleMinutes * 60_000;
      let n = 0;
      for (const row of this.files.values()) {
        const locked = row.preview_locked_at as Date | null;
        if (row.preview_status === 'processing' && locked && locked.getTime() < cutoff) {
          row.preview_status = 'pending';
          row.preview_locked_at = null;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (s.startsWith('UPDATE document_files SET')) {
      const row = this.files.get(String(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      if (s.includes("preview_status = 'failed'")) {
        row.preview_status = 'failed';
        row.preview_error = params[1];
        row.preview_locked_at = null;
      } else if (s.includes("preview_status = 'unsupported'") && s.includes('page_count')) {
        row.page_count = params[1];
        row.preview_status = 'unsupported';
        row.preview_locked_at = null;
      } else if (s.includes("preview_status = 'unsupported'")) {
        row.preview_status = 'unsupported';
        row.preview_error = params[1];
        row.preview_locked_at = null;
      } else if (s.includes("preview_status = 'ready'")) {
        row.page_count = params[1];
        row.preview_pages = params[2];
        row.preview_path = params[3];
        row.preview_status = 'ready';
        row.preview_error = null;
        row.preview_locked_at = null;
      } else {
        throw new Error(`FakePreviewDb: UPDATE không hỗ trợ: ${s.slice(0, 100)}`);
      }
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('SELECT id, document_id, version, storage_path')) {
      const limitMatch = s.match(/LIMIT (\d+)/);
      const limit = limitMatch ? Number(limitMatch[1]) : Number.POSITIVE_INFINITY;
      const rows = [...this.files.values()]
        .filter((f) => f.preview_status === null || f.preview_status === undefined || f.preview_status === 'pending')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit)
        .map((f) => ({ ...f }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`FakePreviewDb: SQL không hỗ trợ: ${s.slice(0, 100)}`);
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

async function makePdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Trang ${i}`, { x: 50, y: 300, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

describe('job tạo bản xem trước (FakeDb + storage thật trong tmp)', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let db: FakePreviewDb;
  let cfg: AppConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-preview-'));
    storage = new LocalDiskStorage(root);
    db = new FakePreviewDb();
    cfg = { ...loadConfig(), previewFileTimeoutMs: 10_000 };
  });

  afterEach(async () => {
    // maxRetries: công việc nền bị timeout vẫn có thể ghi file preview ngay sau đó.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function addPdfFile(pageCount: number, overrides: Record<string, unknown> = {}) {
    const docId = randomUUID();
    const fileId = randomUUID();
    const bytes = await makePdf(pageCount);
    const rel = storage.buildOriginalPath(docId, 1, fileId, 'pdf');
    await storage.saveBytes(bytes, rel);
    const row: Record<string, unknown> = {
      id: fileId,
      document_id: docId,
      version: 1,
      storage_path: rel,
      mime_type: 'application/pdf',
      file_size: bytes.length,
      page_count: null,
      preview_status: 'pending',
      preview_path: null,
      preview_pages: null,
      preview_error: null,
      preview_locked_at: null,
      created_at: new Date().toISOString(),
      ...overrides
    };
    db.addFile(row);
    return row;
  }

  it('xử lý thành công: ready, page_count + preview_pages đúng, file preview tồn tại', async () => {
    const row = await addPdfFile(10);
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, cfg);
    expect(outcome).toBe('ready');
    const saved = db.files.get(String(row.id));
    expect(saved?.preview_status).toBe('ready');
    expect(saved?.page_count).toBe(10);
    expect(saved?.preview_pages).toBe(2);
    expect(await storage.exists(String(saved?.preview_path))).toBe(true);
  });

  it('file không phải PDF -> unsupported', async () => {
    const row = await addPdfFile(3, { mime_type: 'image/png' });
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, cfg);
    expect(outcome).toBe('unsupported');
    expect(db.files.get(String(row.id))?.preview_status).toBe('unsupported');
  });

  it('tài liệu 1 trang -> unsupported (preview sẽ bằng toàn bộ)', async () => {
    const row = await addPdfFile(1);
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, cfg);
    expect(outcome).toBe('unsupported');
    const saved = db.files.get(String(row.id));
    expect(saved?.preview_status).toBe('unsupported');
    expect(saved?.page_count).toBe(1);
    expect(saved?.preview_path).toBeNull();
  });

  it('PDF hỏng -> failed, không ném lỗi ra ngoài', async () => {
    const row = await addPdfFile(3);
    await storage.saveBytes(Buffer.from('%PDF-1.4 noi dung rac'), String(row.storage_path));
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, cfg);
    expect(outcome).toBe('failed');
    const saved = db.files.get(String(row.id));
    expect(saved?.preview_status).toBe('failed');
    expect(String(saved?.preview_error ?? '')).not.toBe('');
  });

  it('file gốc thiếu trên đĩa -> failed', async () => {
    const row = await addPdfFile(3);
    await storage.delete(String(row.storage_path));
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, cfg);
    expect(outcome).toBe('failed');
  });

  it('file vượt trần PREVIEW_MAX_FILE_MB -> failed', async () => {
    const row = await addPdfFile(3, { file_size: 999 * 1024 * 1024 });
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, {
      ...cfg,
      previewMaxFileMb: 1
    });
    expect(outcome).toBe('failed');
    expect(String(db.files.get(String(row.id))?.preview_error)).toContain('giới hạn');
  });

  it('timeout mỗi file -> failed', async () => {
    const row = await addPdfFile(50);
    const outcome = await processPreviewFile(db.asPool(), storage, row as unknown as PreviewFileRow, {
      ...cfg,
      previewFileTimeoutMs: 1
    });
    expect(outcome).toBe('failed');
  });

  it('claim nguyên tử: hai worker đồng thời không nhận trùng một file', async () => {
    await addPdfFile(5);
    const [a, b] = await Promise.all([claimNextPreviewJob(db.asPool()), claimNextPreviewJob(db.asPool())]);
    const claimed = [a, b].filter((r) => r !== null);
    expect(claimed.length).toBe(1);
    // Hàng đợi trống -> claim tiếp trả null.
    await expect(claimNextPreviewJob(db.asPool())).resolves.toBeNull();
  });

  it('job processing quá hạn được nhả lại thành pending; job còn hạn thì không', async () => {
    const stale = await addPdfFile(5, {
      preview_status: 'processing',
      preview_locked_at: new Date(Date.now() - 60 * 60_000)
    });
    const fresh = await addPdfFile(5, {
      preview_status: 'processing',
      preview_locked_at: new Date()
    });
    const released = await releaseStaleJobs(db.asPool(), 15);
    expect(released).toBe(1);
    expect(db.files.get(String(stale.id))?.preview_status).toBe('pending');
    expect(db.files.get(String(fresh.id))?.preview_status).toBe('processing');
  });

  it('runPreviewJobOnce: một file hỏng không làm hỏng cả lượt', async () => {
    const bad = await addPdfFile(3);
    await storage.saveBytes(Buffer.from('rac'), String(bad.storage_path));
    const good = await addPdfFile(10);
    const processed = await runPreviewJobOnce(db.asPool(), storage, cfg, () => undefined, 5);
    expect(processed).toBe(2);
    expect(db.files.get(String(bad.id))?.preview_status).toBe('failed');
    expect(db.files.get(String(good.id))?.preview_status).toBe('ready');
  });
});

describe('backfill:previews (runBackfill)', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let db: FakePreviewDb;
  let cfg: AppConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-backfill-'));
    storage = new LocalDiskStorage(root);
    db = new FakePreviewDb();
    cfg = { ...loadConfig(), previewFileTimeoutMs: 10_000 };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function addFile(pageCount: number, overrides: Record<string, unknown> = {}) {
    const docId = randomUUID();
    const fileId = randomUUID();
    const bytes = await makePdf(pageCount);
    const rel = storage.buildOriginalPath(docId, 1, fileId, 'pdf');
    await storage.saveBytes(bytes, rel);
    const row: Record<string, unknown> = {
      id: fileId,
      document_id: docId,
      version: 1,
      storage_path: rel,
      mime_type: 'application/pdf',
      file_size: bytes.length,
      page_count: null,
      preview_status: null,
      preview_path: null,
      preview_pages: null,
      preview_error: null,
      preview_locked_at: null,
      created_at: new Date().toISOString(),
      ...overrides
    };
    db.addFile(row);
    return row;
  }

  it('idempotent: chạy 2 lần cho cùng kết quả, lần 2 không quét lại file đã xong', async () => {
    await addFile(10);
    await addFile(3, { mime_type: 'image/jpeg' });
    const first = await runBackfill(db.asPool(), storage, cfg, { rate: 1000, limit: null, dryRun: false });
    expect(first).toEqual({ ready: 1, failed: 0, unsupported: 1, skipped: 0 });
    const second = await runBackfill(db.asPool(), storage, cfg, { rate: 1000, limit: null, dryRun: false });
    expect(second).toEqual({ ready: 0, failed: 0, unsupported: 0, skipped: 0 });
  });

  it('file gốc thiếu -> failed, đi tiếp file sau', async () => {
    const missing = await addFile(5);
    await storage.delete(String(missing.storage_path));
    const good = await addFile(10);
    const summary = await runBackfill(db.asPool(), storage, cfg, { rate: 1000, limit: null, dryRun: false });
    expect(summary.failed).toBe(1);
    expect(summary.ready).toBe(1);
    expect(db.files.get(String(missing.id))?.preview_status).toBe('failed');
    expect(db.files.get(String(good.id))?.preview_status).toBe('ready');
  });

  it('--dry-run không ghi gì (không file preview, không đổi trạng thái)', async () => {
    const row = await addFile(10);
    const summary = await runBackfill(db.asPool(), storage, cfg, { rate: 1000, limit: null, dryRun: true });
    expect(summary.skipped).toBe(1);
    expect(summary.ready).toBe(0);
    expect(db.files.get(String(row.id))?.preview_status).toBeNull();
    expect(await storage.exists(storage.buildPreviewPath(String(row.document_id), 1))).toBe(false);
  });

  it('--limit giới hạn số file mỗi lượt', async () => {
    await addFile(10);
    await addFile(10);
    await addFile(10);
    const summary = await runBackfill(db.asPool(), storage, cfg, { rate: 1000, limit: 2, dryRun: false });
    expect(summary.ready).toBe(2);
  });
});

describe.skipIf(!hasDb)('preview job (cần PostgreSQL thật)', () => {
  const pool = hasDb ? createPool(process.env.DATABASE_URL as string) : (null as never);

  it('migration 004 chạy được và chạy lại an toàn; claim nguyên tử trên DB thật', async () => {
    const sql004 = readFileSync(new URL('../migrations/004_previews.sql', import.meta.url), 'utf8');
    await pool.query(sql004);
    await pool.query(sql004); // idempotent

    const doc = await pool.query<{ id: string }>(
      `INSERT INTO documents (title, slug, visibility, status)
       VALUES ('Tai lieu test preview', 'test-preview-004', 'public', 'published')
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`
    );
    const docId = doc.rows[0].id;
    await pool.query('DELETE FROM document_files WHERE document_id = $1', [docId]);
    const file = await pool.query<{ id: string }>(
      `INSERT INTO document_files
         (document_id, version, storage_path, original_filename, mime_type, file_size, checksum_sha256, preview_status)
       VALUES ($1, 1, 'originals/test/v1/f.pdf', 'f.pdf', 'application/pdf', 100, $2, 'pending')
       RETURNING id`,
      [docId, 'b'.repeat(64)]
    );
    const fileId = file.rows[0].id;

    // Hai claim đồng thời: chỉ một bên nhận được việc.
    const [a, b] = await Promise.all([claimNextPreviewJob(pool), claimNextPreviewJob(pool)]);
    const claimed = [a, b].filter((r) => r !== null && r.id === fileId);
    expect(claimed.length).toBe(1);

    await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
  });
});
