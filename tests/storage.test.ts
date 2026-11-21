import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalDiskStorage } from '../src/storage/local-disk.js';

let root: string;
let storage: LocalDiskStorage;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'elib-storage-'));
  storage = new LocalDiskStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalDiskStorage', () => {
  it('save/open/delete round-trip qua đường dẫn tương đối', async () => {
    const rel = storage.buildOriginalPath('doc-1', 1, 'file-1', 'pdf');
    expect(rel).toBe(path.join('originals', 'doc-1', 'v1', 'file-1.pdf'));
    await storage.save(Readable.from(['hello elib']), rel);
    expect(await storage.exists(rel)).toBe(true);

    const stream = await storage.open(rel);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello elib');

    // File thật nằm đúng chỗ dưới STORAGE_ROOT
    const onDisk = await readFile(path.join(root, rel), 'utf8');
    expect(onDisk).toBe('hello elib');

    await storage.delete(rel);
    expect(await storage.exists(rel)).toBe(false);
    await expect(storage.open(rel)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('chặn path traversal', () => {
    expect(() => storage.resolvePath('../outside.txt')).toThrowError(/không hợp lệ/);
    expect(() => storage.resolvePath('originals/../../etc/passwd')).toThrowError(/không hợp lệ/);
    expect(() => storage.resolvePath('/etc/passwd')).toThrowError(/không hợp lệ/);
    expect(() => storage.resolvePath('originals//doc/file.pdf')).toThrowError(/không hợp lệ/);
  });

  it('dọn file tạm khi stream lỗi giữa chừng (không để file mồ côi)', async () => {
    const rel = storage.buildOriginalPath('doc-2', 1, 'file-2', 'pdf');
    const failing = new Readable({
      read() {
        this.push('partial');
        this.destroy(new Error('boom'));
      }
    });
    await expect(storage.save(failing, rel)).rejects.toThrow('boom');
    expect(await storage.exists(rel)).toBe(false);
    // Thư mục tmp phải trống
    const tmpStat = await stat(path.join(root, 'tmp')).catch(() => null);
    if (tmpStat) {
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(path.join(root, 'tmp'))).toEqual([]);
    }
  });

  it('commitTemp chuyển file tạm vào chỗ chính thức, discardTemp xóa file tạm', async () => {
    const tmpPath = await storage.createTempPath();
    await writeFile(tmpPath, 'data');
    const rel = storage.buildOriginalPath('doc-3', 1, 'file-3', 'txt');
    await storage.commitTemp(tmpPath, rel);
    expect(await storage.exists(rel)).toBe(true);
    await expect(stat(tmpPath)).rejects.toBeTruthy();

    const tmp2 = await storage.createTempPath();
    await writeFile(tmp2, 'x');
    await storage.discardTemp(tmp2);
    await expect(stat(tmp2)).rejects.toBeTruthy();
  });

  it('delete file không tồn tại không ném lỗi', async () => {
    await expect(storage.delete(path.join('originals', 'nope', 'v1', 'nope.pdf'))).resolves.toBeUndefined();
  });
});
