import 'dotenv/config';
import path from 'node:path';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * TRUST_PROXY: số hop proxy tin cậy phía trước (Fastify trustProxy dạng số).
 * - Không đặt / 'false' / '0' -> false (không tin X-Forwarded-For).
 * - 'true' / '1' -> 1 (đúng một lớp Reverse_proxy/Caddy).
 * - Số nguyên dương khác -> đúng số hop đó.
 * Giá trị lạ -> false (an toàn: không tin header giả mạo).
 */
function trustProxyFromEnv(name: string): boolean | number {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : false;
}

function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export interface AppConfig {
  databaseUrl: string;
  storageRoot: string;
  maxUploadBytes: number;
  maxUploadMb: number;
  port: number;
  host: string;
  sessionSecret: string;
  cookieSecure: boolean;
  sessionTtlDays: number;
  logLevel: string;
  /**
   * Số hop proxy tin cậy (Fastify trustProxy): chỉ tin X-Forwarded-For từ
   * đúng số lớp Reverse_proxy/Caddy này (ảnh hưởng IP dùng cho rate limit).
   * Mặc định false; TRUST_PROXY=true hoặc =1 khi đứng sau đúng một lớp proxy.
   */
  trustProxy: boolean | number;
  /** Trần số tài khoản đang chờ duyệt (MAX_PENDING_USERS, mặc định 200). */
  maxPendingUsers: number;
  /** Sai mật khẩu tối đa theo (username+IP) trước khi khóa tạm (LOGIN_MAX_FAILED, mặc định 5). */
  loginMaxFailed: number;
  /** Thời gian khóa tạm đăng nhập, phút (LOGIN_LOCK_MINUTES, mặc định 15). */
  loginLockMinutes: number;
  /** Rate limit đăng ký theo IP (REGISTER_RATE_MAX / REGISTER_RATE_WINDOW_MINUTES, mặc định 5 / 60 phút). */
  registerRateMax: number;
  registerRateWindowMs: number;
  /** Rate limit đăng nhập theo IP (LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_MINUTES, mặc định 20 / 15 phút). */
  loginRateMax: number;
  loginRateWindowMs: number;
  /**
   * Danh sách tên miền email nội bộ (INTERNAL_EMAIL_DOMAINS, phân cách dấu phẩy).
   * Chỉ dùng để gợi ý trên trang duyệt của admin — không tự duyệt/tự gán user_type.
   */
  internalEmailDomains: string[];
  /**
   * Bí mật dùng chung cho API nội bộ /internal/standards/* (Reverse_proxy
   * gửi qua header X-Internal-Token). Chưa đặt → API nội bộ tắt (503).
   * Không bao giờ log giá trị này.
   */
  standardsInternalToken: string | null;
  /** Tỉ lệ số trang được xem trước (PREVIEW_RATIO, mặc định 0.2, validate ở previews/page-count.ts). */
  previewRatio: number;
  /** Trần số trang xem trước (PREVIEW_MAX_PAGES, mặc định 10). */
  previewMaxPages: number;
  /** File gốc lớn hơn mức này (MB) sẽ không tạo bản xem trước (PREVIEW_MAX_FILE_MB, mặc định 50). */
  previewMaxFileMb: number;
  /** Chu kỳ poll của job tạo bản xem trước, ms (PREVIEW_JOB_INTERVAL_MS, mặc định 5000). */
  previewJobIntervalMs: number;
  /** Job 'processing' quá số phút này được nhả lại thành 'pending' (PREVIEW_LOCK_STALE_MINUTES, mặc định 15). */
  previewLockStaleMinutes: number;
  /** Timeout xử lý mỗi file, ms (PREVIEW_FILE_TIMEOUT_MS, mặc định 60000). */
  previewFileTimeoutMs: number;
  /** Bật job nền tạo bản xem trước trong server (PREVIEW_JOB_ENABLED, mặc định true). */
  previewJobEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxUploadMb = intFromEnv('MAX_UPLOAD_MB', 200);
  // Validate PREVIEW_RATIO: chỉ chấp nhận (0, 1]; giá trị sai rơi về mặc định 0.2.
  const previewRatioRaw = floatFromEnv('PREVIEW_RATIO', 0.2);
  const previewRatio = previewRatioRaw > 0 && previewRatioRaw <= 1 ? previewRatioRaw : 0.2;
  const storageRootRaw = env.STORAGE_ROOT ?? path.join(process.cwd(), 'storage');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://elib:change-me@localhost:5432/elib',
    // Luôn resolve thành đường dẫn tuyệt đối; mọi join đều qua path.join.
    storageRoot: path.resolve(storageRootRaw),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxUploadMb,
    port: intFromEnv('PORT', 3200),
    host: env.HOST ?? '0.0.0.0',
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-change-me',
    cookieSecure: boolFromEnv('COOKIE_SECURE', false),
    sessionTtlDays: intFromEnv('SESSION_TTL_DAYS', 7),
    logLevel: env.LOG_LEVEL ?? 'info',
    trustProxy: trustProxyFromEnv('TRUST_PROXY'),
    maxPendingUsers: intFromEnv('MAX_PENDING_USERS', 200),
    loginMaxFailed: intFromEnv('LOGIN_MAX_FAILED', 5),
    loginLockMinutes: intFromEnv('LOGIN_LOCK_MINUTES', 15),
    registerRateMax: intFromEnv('REGISTER_RATE_MAX', 5),
    registerRateWindowMs: intFromEnv('REGISTER_RATE_WINDOW_MINUTES', 60) * 60 * 1000,
    loginRateMax: intFromEnv('LOGIN_RATE_MAX', 20),
    loginRateWindowMs: intFromEnv('LOGIN_RATE_WINDOW_MINUTES', 15) * 60 * 1000,
    internalEmailDomains: listFromEnv('INTERNAL_EMAIL_DOMAINS'),
    standardsInternalToken: env.STANDARDS_INTERNAL_TOKEN?.trim() || null,
    previewRatio,
    previewMaxPages: intFromEnv('PREVIEW_MAX_PAGES', 10),
    previewMaxFileMb: intFromEnv('PREVIEW_MAX_FILE_MB', 50),
    previewJobIntervalMs: intFromEnv('PREVIEW_JOB_INTERVAL_MS', 5000),
    previewLockStaleMinutes: intFromEnv('PREVIEW_LOCK_STALE_MINUTES', 15),
    previewFileTimeoutMs: intFromEnv('PREVIEW_FILE_TIMEOUT_MS', 60000),
    previewJobEnabled: boolFromEnv('PREVIEW_JOB_ENABLED', true)
  };
}

export const config: AppConfig = loadConfig();
