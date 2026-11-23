import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { AppError } from '../errors.js';
import type { StorageService } from './types.js';
import { originalRelativePathParts, previewRelativePathParts } from './types.js';

export class LocalDiskStorage implements StorageService {
  readonly root: string;
  private readonly tmpDir: string;

  constructor(storageRoot: string) {
    this.root = path.resolve(storageRoot);
    // Thư mục tạm nằm TRONG STORAGE_ROOT (cùng filesystem) để rename là nguyên tử.
    this.tmpDir = path.join(this.root, 'tmp');
  }

  /** Đường dẫn tương đối chuẩn (dùng path.join, không viết cứng dấu phân cách). */
  buildOriginalPath(docId: string, version: number, fileId: string, ext: string): string {
    return path.join(...originalRelativePathParts(docId, version, fileId, ext));
  }

  /** Đường dẫn tương đối chuẩn cho file xem trước của một phiên bản tài liệu. */
  buildPreviewPath(docId: string, version: number): string {
    return path.join(...previewRelativePathParts(docId, version));
  }

  /**
   * Resolve đường dẫn tương đối thành tuyệt đối và chặn path traversal:
   * kết quả bắt buộc nằm trong STORAGE_ROOT.
   */
  resolvePath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new AppError(400, 'INVALID_PATH', 'Đường dẫn lưu trữ không hợp lệ');
    }
    // Chặn sẵn các đoạn ".." trước khi resolve (kể cả dùng dấu phân cách lạ).
    const segments = relativePath.split(/[\\/]/);
    if (segments.some((s) => s === '..' || s === '')) {
      throw new AppError(400, 'INVALID_PATH', 'Đường dẫn lưu trữ không hợp lệ');
    }
    const resolved = path.resolve(this.root, relativePath);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new AppError(400, 'INVALID_PATH', 'Đường dẫn lưu trữ không hợp lệ');
    }
    return resolved;
  }

  /** Tạo một file tạm trống và trả đường dẫn tuyệt đối của nó. */
  async createTempPath(): Promise<string> {
    await mkdir(this.tmpDir, { recursive: true });
    return path.join(this.tmpDir, `${randomUUID()}.part`);
  }

  async save(stream: Readable, relativePath: string): Promise<void> {
    const finalPath = this.resolvePath(relativePath);
    const tempPath = await this.createTempPath();
    try {
      await pipeline(stream, createWriteStream(tempPath, { flags: 'wx' }));
      await mkdir(path.dirname(finalPath), { recursive: true });
      await rename(tempPath, finalPath);
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Chuyển một file tạm (đã ghi xong, đã kiểm tra) vào vị trí chính thức.
   * Dùng trong luồng upload: ghi tạm + hash + validate trước, commit sau.
   */
  async commitTemp(tempAbsolutePath: string, relativePath: string): Promise<void> {
    const finalPath = this.resolvePath(relativePath);
    const resolvedTemp = path.resolve(tempAbsolutePath);
    const tmpWithSep = this.tmpDir.endsWith(path.sep) ? this.tmpDir : this.tmpDir + path.sep;
    if (!resolvedTemp.startsWith(tmpWithSep)) {
      throw new AppError(400, 'INVALID_PATH', 'File tạm không thuộc thư mục tạm của hệ thống');
    }
    await mkdir(path.dirname(finalPath), { recursive: true });
    await rename(resolvedTemp, finalPath);
  }

  async discardTemp(tempAbsolutePath: string): Promise<void> {
    await rm(tempAbsolutePath, { force: true }).catch(() => undefined);
  }

  async open(relativePath: string): Promise<Readable> {
    const absolute = this.resolvePath(relativePath);
    const st = await stat(absolute).catch(() => null);
    if (!st || !st.isFile()) {
      throw new AppError(404, 'FILE_NOT_FOUND', 'Không tìm thấy file tài liệu');
    }
    return createReadStream(absolute);
  }

  async delete(relativePath: string): Promise<void> {
    const absolute = this.resolvePath(relativePath);
    await rm(absolute, { force: true });
    // Dọn thư mục rỗng cha (v{version} -> {doc_id}) nếu còn trống; bỏ qua lỗi.
    await rm(path.dirname(absolute), { recursive: false }).catch(() => undefined);
    await rm(path.dirname(path.dirname(absolute)), { recursive: false }).catch(() => undefined);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const absolute = this.resolvePath(relativePath);
      const st = await stat(absolute);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async saveBytes(bytes: Uint8Array, relativePath: string): Promise<void> {
    const { Readable } = await import('node:stream');
    await this.save(Readable.from([Buffer.from(bytes)]), relativePath);
  }

  async readBytes(relativePath: string, maxBytes: number): Promise<Buffer> {
    const absolute = this.resolvePath(relativePath);
    const st = await stat(absolute).catch(() => null);
    if (!st || !st.isFile()) {
      throw new AppError(404, 'FILE_NOT_FOUND', 'Không tìm thấy file tài liệu');
    }
    if (st.size > maxBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', 'File vượt quá giới hạn xử lý xem trước');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of createReadStream(absolute)) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        throw new AppError(413, 'FILE_TOO_LARGE', 'File vượt quá giới hạn xử lý xem trước');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  /** Xóa toàn bộ thư mục xem trước của một tài liệu (khi tài liệu bị xóa). */
  async deletePreviewDir(docId: string): Promise<void> {
    const dir = this.resolvePath(path.join('previews', docId));
    await rm(dir, { recursive: true, force: true });
  }
}
