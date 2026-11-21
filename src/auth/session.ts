import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const SESSION_COOKIE = 'elib_session';

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string | null;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function newRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Session phía server: cookie chứa token ngẫu nhiên, DB chỉ lưu SHA-256 của token.
 * Cookie: httpOnly, SameSite=Lax, Secure cấu hình qua COOKIE_SECURE (tắt khi chạy HTTP trong LAN).
 */
export async function createSession(pool: pg.Pool, userId: string, ttlDays: number): Promise<string> {
  const raw = newRawToken();
  const expires = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(raw), expires.toISOString()]
  );
  return raw;
}

export async function userFromSessionToken(pool: pg.Pool, rawToken: string | undefined): Promise<CurrentUser | null> {
  if (!rawToken) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(rawToken)]
  );
  const row = result.rows[0] as
    | { id: string; email: string; role: UserRole; display_name: string | null }
    | undefined;
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role, displayName: row.display_name };
}

export async function deleteSession(pool: pg.Pool, rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(rawToken)]);
}

export function canUpload(user: CurrentUser | null): boolean {
  return !!user && (user.role === 'admin' || user.role === 'editor');
}

export interface DocumentAccessRow {
  status: string;
  visibility: string;
  created_by: string | null;
}

/**
 * Ma trận quyền tải file (Giai đoạn 1):
 * - draft/hidden: người tạo, editor, admin (viewer không bao giờ).
 * - published + public: mọi người (kể cả chưa đăng nhập).
 * - published + internal: mọi người dùng đã đăng nhập.
 * - published + private: người tạo hoặc admin.
 */
export function canDownload(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  if (doc.status === 'draft' || doc.status === 'hidden') {
    return !!user && (user.id === doc.created_by || user.role === 'editor' || user.role === 'admin');
  }
  // published
  if (doc.visibility === 'public') return true;
  if (!user) return false;
  if (doc.visibility === 'internal') return true;
  // private
  return user.id === doc.created_by || user.role === 'admin';
}
