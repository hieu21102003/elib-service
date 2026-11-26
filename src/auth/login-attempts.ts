import type pg from 'pg';

/**
 * Khóa tạm đăng nhập theo (định danh + IP) — bảng login_attempts.
 * Đếm cả định danh không tồn tại để chống dò tài khoản; thông báo lỗi
 * luôn chung chung. Admin mở khóa bằng cách xóa các dòng của người dùng.
 */

/** Chuẩn hóa định danh đăng nhập (username/email) để so khớp và làm khóa đếm. */
export function normalizeIdentifier(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase();
}

/** Chuẩn hóa username khi lưu: NFC + trim (giữ nguyên hoa/thường như người dùng nhập). */
export function normalizeUsername(raw: string): string {
  return raw.normalize('NFC').trim();
}

interface AttemptRow {
  failed_count: number;
  locked_until: Date | string | null;
}

export async function getLoginAttempt(
  pool: pg.Pool,
  identifier: string,
  ip: string
): Promise<AttemptRow | null> {
  const result = await pool.query(
    'SELECT failed_count, locked_until FROM login_attempts WHERE identifier = $1 AND ip = $2',
    [identifier, ip]
  );
  return (result.rows[0] as AttemptRow | undefined) ?? null;
}

export function isLocked(attempt: AttemptRow | null, now: Date = new Date()): boolean {
  if (!attempt?.locked_until) return false;
  return new Date(attempt.locked_until).getTime() > now.getTime();
}

/** Ghi nhận một lần đăng nhập sai; đạt ngưỡng thì đặt locked_until. */
export async function recordLoginFailure(
  pool: pg.Pool,
  identifier: string,
  ip: string,
  maxFailed: number,
  lockMinutes: number
): Promise<void> {
  const existing = await getLoginAttempt(pool, identifier, ip);
  const failedCount = (existing?.failed_count ?? 0) + 1;
  const lockedUntil =
    failedCount >= maxFailed ? new Date(Date.now() + lockMinutes * 60 * 1000) : null;
  if (existing) {
    await pool.query(
      'UPDATE login_attempts SET failed_count = $3, locked_until = $4, updated_at = now() WHERE identifier = $1 AND ip = $2',
      [identifier, ip, failedCount, lockedUntil?.toISOString() ?? null]
    );
  } else {
    await pool.query(
      'INSERT INTO login_attempts (identifier, ip, failed_count, locked_until) VALUES ($1, $2, $3, $4)',
      [identifier, ip, failedCount, lockedUntil?.toISOString() ?? null]
    );
  }
}

/** Đăng nhập đúng: xóa bộ đếm của (định danh + IP). */
export async function clearLoginAttempts(pool: pg.Pool, identifier: string, ip: string): Promise<void> {
  await pool.query('DELETE FROM login_attempts WHERE identifier = $1 AND ip = $2', [identifier, ip]);
}

/** Admin mở khóa: xóa mọi bộ đếm của các định danh (email/username) của người dùng. */
export async function clearLoginAttemptsForIdentifiers(
  pool: pg.Pool,
  identifiers: string[]
): Promise<void> {
  const normalized = [...new Set(identifiers.map(normalizeIdentifier).filter((s) => s.length > 0))];
  if (normalized.length === 0) return;
  await pool.query('DELETE FROM login_attempts WHERE identifier = ANY($1)', [normalized]);
}
