import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import type pg from 'pg';
import { loadConfig, type AppConfig } from './config.js';
import { createPool } from './db.js';
import { AppError } from './errors.js';
import { LocalDiskStorage } from './storage/local-disk.js';
import { registerAuthRoutes, getCurrentUser } from './routes/auth.js';
import { registerAdminUserRoutes } from './routes/admin-users.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerPreviewRoutes } from './routes/previews.js';
import { registerInternalStandardsRoutes } from './routes/internal-standards.js';
import { startPreviewJob } from './previews/job.js';
import { SESSION_COOKIE as SESSION_COOKIE_NAME } from './auth/session.js';

export interface CreateAppOptions {
  pool?: pg.Pool;
  storage?: LocalDiskStorage;
  config?: AppConfig;
  /**
   * Bật job nền tạo bản xem trước. Mặc định TẮT khi tạo app qua createApp
   * (test không bị vòng lặp nền quấy nhiễu); server.ts bật khi
   * PREVIEW_JOB_ENABLED=true.
   */
  previewJob?: boolean;
}

export async function createApp(opts: CreateAppOptions = {}) {
  const cfg = opts.config ?? loadConfig();
  const pool = opts.pool ?? createPool(cfg.databaseUrl);
  const storage = opts.storage ?? new LocalDiskStorage(cfg.storageRoot);

  // trustProxy: Fastify v5 KHÔNG hỗ trợ dạng số (coi là không tin gì cả),
  // nên chuyển "số hop" trong config thành trust function: chỉ tin đúng
  // N địa chỉ đầu chuỗi (peer trực tiếp + các proxy gần nhất). TRUST_PROXY=true
  // trong config đã được chuẩn hóa thành 1 (đúng một lớp Reverse_proxy).
  const trustProxyHops = cfg.trustProxy === true ? 1 : cfg.trustProxy;
  const app = Fastify({
    logger: { level: cfg.logLevel },
    trustProxy:
      trustProxyHops === false
        ? false
        : (_addr: string, i: number) => i < (trustProxyHops as number)
  });

  await app.register(cookie);
  // Rate limit chỉ áp dụng cho route nào khai config.rateLimit (các GET công khai);
  // upload/login không bị ảnh hưởng. Lỗi 429 trả JSON tiếng Việt qua AppError.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new AppError(
        context.statusCode,
        context.statusCode === 403 ? 'RATE_LIMIT_BANNED' : 'RATE_LIMITED',
        'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.'
      )
  });
  await app.register(multipart, {
    limits: {
      fileSize: cfg.maxUploadBytes,
      files: 1,
      fields: 30,
      fieldSize: 1024 * 1024
    }
  });

  /**
   * CSRF: cookie SameSite=Lax + kiểm tra Origin/Referer cho mọi request đổi
   * trạng thái qua cookie (POST/PATCH/PUT/DELETE dưới /api/*). Trình duyệt
   * luôn gửi Origin với fetch/XHR POST; nếu Origin (hoặc Referer khi không có
   * Origin) lệch host của request thì chặn 403. Không có cả hai (client
   * không phải trình duyệt) thì cho qua — SameSite vẫn bảo vệ phía trình duyệt.
   * So host với request.hostname (tôn trọng X-Forwarded-Host khi trustProxy bật).
   * API nội bộ /internal/* dùng token header, không dùng cookie — miễn kiểm tra.
   */
  app.addHook('preHandler', async (request) => {
    const method = request.method.toUpperCase();
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return;
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    const source = request.headers.origin ?? request.headers.referer;
    if (!source) return;
    let sourceHost: string | null = null;
    try {
      sourceHost = new URL(source).host;
    } catch {
      sourceHost = null;
    }
    if (!sourceHost || sourceHost !== request.hostname) {
      throw new AppError(403, 'CSRF_ORIGIN_MISMATCH', 'Yêu cầu bị từ chối vì nguồn gửi không hợp lệ.');
    }
  });

  /**
   * Thu hồi phiên + bắt đổi mật khẩu: mỗi request có cookie đều tra lại
   * người dùng từ DB (userFromSessionToken đã kiểm status/role/user_type).
   * Tài khoản đang dùng mật khẩu tạm (must_change_password) chỉ được gọi
   * change-password/logout/me; các API khác trả 403 MUST_CHANGE_PASSWORD.
   */
  const MUST_CHANGE_ALLOWLIST = new Set([
    'POST /api/auth/change-password',
    'POST /api/auth/logout',
    'GET /api/auth/me'
  ]);
  app.addHook('preHandler', async (request) => {
    if (!request.cookies[SESSION_COOKIE_NAME]) return;
    const user = await getCurrentUser(pool, request.cookies);
    request.currentUser = user;
    if (!user?.mustChangePassword) return;
    const key = `${request.method.toUpperCase()} ${request.url.split('?')[0]}`;
    if (MUST_CHANGE_ALLOWLIST.has(key)) return;
    throw new AppError(
      403,
      'MUST_CHANGE_PASSWORD',
      'Bạn đang dùng mật khẩu tạm. Vui lòng đổi mật khẩu trước khi tiếp tục.'
    );
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
  registerAdminUserRoutes(app, pool, cfg);
  registerCategoryRoutes(app, pool);
  registerDocumentRoutes(app, pool, storage, cfg);
  registerPreviewRoutes(app, pool, storage, cfg);
  registerInternalStandardsRoutes(app, pool, cfg);

  if (opts.previewJob) {
    const job = startPreviewJob(pool, storage, cfg, (message) => app.log.info(message));
    app.addHook('onClose', async () => {
      job.stop();
    });
  }

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Không tìm thấy đường dẫn' } });
  });

  return app;
}
