import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export const SESSION_COOKIE = 'elib_session';

export type UserRole = 'admin' | 'editor' | 'viewer';
export type UserType = 'internal' | 'external';
export type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled';

export interface CurrentUser {
  id: string;
  /** Tên đăng nhập (NULL với tài khoản cũ tạo trước migration 005 — đăng nhập bằng email). */
  username: string | null;
  email: string;
  role: UserRole;
  displayName: string | null;
  /** internal = người công ty, external = khách ngoài, null = chưa được gán (chỉ có ở pending). */
  userType: UserType | null;
  status: UserStatus;
  /** Đang dùng mật khẩu tạm (admin đặt lại) — chỉ được vào màn hình đổi mật khẩu. */
  mustChangePassword: boolean;
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

/**
 * Tra người dùng từ session token — LUÔN đọc role/status/user_type từ DB ở
 * mỗi request (không tin giá trị cache trong cookie), nên vô hiệu hóa/từ chối/
 * đổi role/đổi user_type có hiệu lực ngay ở request kế tiếp.
 * Tài khoản không ở trạng thái 'active' coi như chưa đăng nhập (phiên bị thu hồi).
 * Row thiếu cột status (FakePool cũ / DB chưa migrate 005) được coi là 'active'
 * để không phá vỡ hành vi trước migration.
 */
export async function userFromSessionToken(pool: pg.Pool, rawToken: string | undefined): Promise<CurrentUser | null> {
  if (!rawToken) return null;
  const result = await pool.query(
    `SELECT u.id, u.username, u.email, u.role, u.display_name, u.status, u.user_type, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(rawToken)]
  );
  const row = result.rows[0] as
    | {
        id: string;
        username: string | null;
        email: string;
        role: UserRole;
        display_name: string | null;
        status: UserStatus | null;
        user_type: UserType | null;
        must_change_password: boolean | null;
      }
    | undefined;
  if (!row) return null;
  const status = row.status ?? 'active';
  if (status !== 'active') return null;
  return {
    id: row.id,
    username: row.username ?? null,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
    userType: row.user_type ?? null,
    status,
    mustChangePassword: row.must_change_password === true
  };
}

export async function deleteSession(pool: pg.Pool, rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(rawToken)]);
}

/** Xóa mọi phiên của một người dùng (khi admin đặt lại mật khẩu / vô hiệu hóa). */
export async function deleteAllSessions(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** Xóa mọi phiên trừ phiên hiện tại (khi người dùng tự đổi mật khẩu). */
export async function deleteOtherSessions(
  pool: pg.Pool,
  userId: string,
  currentRawToken: string | undefined
): Promise<void> {
  if (!currentRawToken) {
    await deleteAllSessions(pool, userId);
    return;
  }
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [
    userId,
    hashToken(currentRawToken)
  ]);
}

export function canUpload(user: CurrentUser | null): boolean {
  return !!user && (user.role === 'admin' || user.role === 'editor');
}

/**
 * Quyền tải FILE TIÊU CHUẨN lên (upload có standard_code): admin hoặc
 * người trong tổ chức (user_type=internal, mọi role kể cả viewer nội bộ),
 * và phải đang status=active. Upload tài liệu thường vẫn dùng canUpload
 * (admin/editor) như cũ.
 */
export function canUploadStandardFile(user: CurrentUser | null): boolean {
  return isActiveUser(user) && (user.role === 'admin' || user.userType === 'internal');
}

export interface DocumentAccessRow {
  status: string;
  visibility: string;
  created_by: string | null;
  /** Mã tiêu chuẩn đã gắn (documents.standard_id); null/không có = tài liệu thường. */
  standard_id?: string | null;
}

/** Người dùng có tài khoản đang hoạt động (status='active') hay không. */
export function isActiveUser(user: CurrentUser | null): user is CurrentUser {
  return !!user && user.status === 'active';
}

/** Người dùng có quyền với tài liệu 'members' không: đã đăng nhập và status=active (gồm cả external). */
export function canAccessMembers(user: CurrentUser | null): boolean {
  return isActiveUser(user);
}

/** Người dùng có quyền với tài liệu 'internal' không: status=active và (nội bộ hoặc editor/admin). */
export function canAccessInternal(user: CurrentUser | null): boolean {
  return isActiveUser(user) && (user.userType === 'internal' || user.role === 'editor' || user.role === 'admin');
}

/**
 * Ma trận quyền "thấy tài liệu" (danh sách + bản xem trước):
 * - draft/hidden: người tạo, editor, admin (viewer không bao giờ; cần status=active).
 * - published + public: mọi người (kể cả chưa đăng nhập).
 * - published + members: mọi tài khoản đã đăng nhập và status=active (gồm cả external).
 * - published + internal: CHỈ người nội bộ (user_type=internal) hoặc editor/admin (status=active).
 *   Khách ngoài (external) đã đăng nhập cũng không thấy được.
 * - published + private: người tạo hoặc admin (status=active).
 *
 * LƯU Ý: đây KHÔNG còn là quyền tải bản gốc. Tải file gốc dùng quy tắc chặt
 * hơn ở canDownloadOriginal() bên dưới; ma trận này chỉ còn quyết định ai
 * thấy tài liệu trong danh sách và ai xem được bản xem trước.
 */
export function canDownload(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  const active = isActiveUser(user) ? user : null;
  if (doc.status === 'draft' || doc.status === 'hidden') {
    return !!active && (active.id === doc.created_by || active.role === 'editor' || active.role === 'admin');
  }
  // published
  if (doc.visibility === 'public') return true;
  if (!active) return false;
  if (doc.visibility === 'members') return canAccessMembers(active);
  if (doc.visibility === 'internal') return canAccessInternal(active);
  // private
  return active.id === doc.created_by || active.role === 'admin';
}

/**
 * Quyền tải BẢN GỐC (file gốc qua .../download) — chặt hơn ma trận
 * "thấy tài liệu" ở trên: CHỈ người tạo tài liệu (documents.created_by)
 * hoặc admin (và phải đang status=active). Editor không phải người tạo,
 * viewer nội bộ/ngoài đều KHÔNG tải được bản gốc (họ vẫn thấy tài liệu
 * trong danh sách và xem bản xem trước theo ma trận trên). Quy tắc không
 * phụ thuộc status/visibility. /view (xem toàn bộ online) dùng chung quy tắc
 * này qua canViewFull.
 *
 * Điểm mở rộng tương lai: khi có tính năng mua tài liệu, kiểm tra quyền
 * của người đã mua (purchaser) sẽ được thêm TẠI ĐÂY — chỉ sửa một chỗ này.
 */
export function canDownloadOriginal(user: CurrentUser | null, doc: DocumentAccessRow): boolean {
  if (!isActiveUser(user)) return false;
  return user.id === doc.created_by || user.role === 'admin';
}
