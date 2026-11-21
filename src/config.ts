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
   * Tin header X-Forwarded-For khi đứng sau Reverse_proxy/Caddy (ảnh hưởng IP
   * dùng cho rate limit). Mặc định false; đặt TRUST_PROXY=true khi có proxy tin cậy.
   */
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const maxUploadMb = intFromEnv('MAX_UPLOAD_MB', 200);
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
    trustProxy: boolFromEnv('TRUST_PROXY', false)
  };
}

export const config: AppConfig = loadConfig();
