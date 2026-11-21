import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import type pg from 'pg';
import { loadConfig, type AppConfig } from './config.js';
import { createPool } from './db.js';
import { AppError } from './errors.js';
import { LocalDiskStorage } from './storage/local-disk.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerDocumentRoutes } from './routes/documents.js';

export interface CreateAppOptions {
  pool?: pg.Pool;
  storage?: LocalDiskStorage;
  config?: AppConfig;
}

export async function createApp(opts: CreateAppOptions = {}) {
  const cfg = opts.config ?? loadConfig();
  const pool = opts.pool ?? createPool(cfg.databaseUrl);
  const storage = opts.storage ?? new LocalDiskStorage(cfg.storageRoot);

  const app = Fastify({ logger: { level: cfg.logLevel } });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: cfg.maxUploadBytes,
      files: 1,
      fields: 30,
      fieldSize: 1024 * 1024
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.' }
      });
    }
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('FST_') || code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return reply.code(400).send({
        error: { code: 'INVALID_UPLOAD', message: 'Upload không hợp lệ hoặc file quá lớn. Vui lòng thử lại.' }
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau.' }
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'elib-service',
    timestamp: new Date().toISOString()
  }));

  // Trang upload TẠM của elib (Giai đoạn 1). Sẽ thay bằng giao diện Smart.Rail khi tích hợp.
  const serveUploadPage = async (_request: unknown, reply: { type: (t: string) => unknown; send: (b: unknown) => unknown }) => {
    const html = await readFile(new URL('../public/upload.html', import.meta.url));
    (reply as { type: (t: string) => { send: (b: unknown) => unknown } }).type('text/html; charset=utf-8').send(html);
  };
  app.get('/', serveUploadPage as never);
  app.get('/upload', serveUploadPage as never);

  registerAuthRoutes(app, pool, cfg);
  registerCategoryRoutes(app, pool);
  registerDocumentRoutes(app, pool, storage, cfg);

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Không tìm thấy đường dẫn' } });
  });

  return app;
}
