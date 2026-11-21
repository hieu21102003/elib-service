import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/** Transform vừa đếm dung lượng vừa tính SHA-256, không giữ file trong RAM. */
export class HashAndCountTransform extends Transform {
  private readonly hash = createHash('sha256');
  size = 0;
  private readonly maxBytes: number;
  exceeded = false;

  constructor(maxBytes: number) {
    super();
    this.maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      this.exceeded = true;
      cb(new Error('FILE_TOO_LARGE'));
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}

export async function sha256OfFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
