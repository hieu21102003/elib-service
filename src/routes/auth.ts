import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { AppError, badRequest, conflict, unauthorized } from '../errors.js';
import {
  checkPasswordPolicy,
  dummyPasswordHash,
  hashPassword,
  verifyPassword
} from '../auth/password.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteOtherSessions,
  deleteSession,
  userFromSessionToken,
  type CurrentUser,
  type UserRole,
  type UserStatus,
  type UserType
} from '../auth/session.js';
import {
  clearLoginAttempts,
  getLoginAttempt,
  isLocked,
  normalizeIdentifier,
  normalizeUsername,
  recordLoginFailure
} from '../auth/login-attempts.js';

const GENERIC_LOGIN_ERROR = 'Email/tên đăng nhập hoặc mật khẩu không đúng';

const loginSchema = z.object({
  // Chấp nhận 'identifier' (email hoặc username) và 'email' (client cũ).
  identifier: z.string().trim().min(1).max(254).optional(),
  email: z.string().trim().min(1).max(254).optional(),
  password: z.string().min(1).max(1024)
});

const registerSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1024),
  displayName: z.string().trim().max(100).optional(),
  fullName: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(254),
  // Honeypot: người thật không điền trường ẩn này.
  website: z.string().max(500).optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024)
});

interface UserRow {
  id: string;
  username: string | null;
  email: string;
  password_hash: string;
  role: UserRole;
  display_name: string | null;
  status: UserStatus;
  user_type: UserType | null;
  must_change_password: boolean;
}

const USER_COLUMNS =
  'id, username, email, password_hash, role, display_name, status, user_type, must_change_password';

function toCurrentUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
    userType: row.user_type,
    status: row.status,
    mustChangePassword: row.must_change_password === true
  };
}

export async function getCurrentUser(
  pool: pg.Pool,
  cookies: Record<string, string | undefined>
): Promise<CurrentUser | null> {
  return userFromSessionToken(pool, cookies[SESSION_COOKIE]);
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AppConfig): void {
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: cfg.registerRateMax, timeWindow: cfg.registerRateWindowMs } } },
    async (request, reply) => {
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      // Honeypot: bot điền trường ẩn 'website' -> trả thành công giả, không tạo tài khoản.
      if (typeof rawBody.website === 'string' && rawBody.website.trim().length > 0) {
        request.log.warn({ audit: 'registration_honeypot', ip: request.ip }, 'registration honeypot hit');
        return reply.code(201).send({
          status: 'pending',
          message: 'Đã gửi đăng ký. Vui lòng chờ quản trị viên duyệt tài khoản.'
        });
      }

      const parsed = registerSchema.safeParse(rawBody);
      if (!parsed.success) {
        throw badRequest('INVALID_INPUT', 'Dữ liệu đăng ký không hợp lệ. Vui lòng kiểm tra lại các trường.');
      }
      const data = parsed.data;
      const username = normalizeUsername(data.username);
      if (username.length < 3 || username.length > 50 || /\s/.test(username) || username.includes('@')) {
        throw badRequest(
          'INVALID_USERNAME',
          'Tên đăng nhập phải dài 3–50 ký tự, không chứa khoảng trắng và ký tự @.'
        );
      }
      const email = data.email.trim();
      const policy = checkPasswordPolicy(data.password, { username, email });
      if (!policy.ok) throw badRequest(policy.code, policy.message);

      // Trần số tài khoản chờ duyệt.
      const pendingRes = await pool.query(
        "SELECT COUNT(*)::int AS total FROM users WHERE status = 'pending'"
      );
      if ((pendingRes.rows[0] as { total: number }).total >= cfg.maxPendingUsers) {
        throw new AppError(
          429,
          'PENDING_LIMIT_REACHED',
          'Số tài khoản đang chờ duyệt đã đạt giới hạn. Vui lòng thử lại sau.'
        );
      }

      const usernameTaken = await pool.query(
        'SELECT id FROM users WHERE username IS NOT NULL AND lower(username) = lower($1)',
        [username]
      );
      if (usernameTaken.rows.length > 0) {
        throw conflict('USERNAME_TAKEN', 'Tên đăng nhập đã được sử dụng. Vui lòng chọn tên khác.');
      }
      // Email của tài khoản bị từ chối (rejected) được giải phóng để dùng lại.
      const emailTaken = await pool.query(
        "SELECT id FROM users WHERE lower(email) = lower($1) AND status <> 'rejected'",
        [email]
      );
      if (emailTaken.rows.length > 0) {
        throw conflict('EMAIL_TAKEN', 'Email đã được sử dụng. Vui lòng dùng email khác.');
      }

      const passwordHash = await hashPassword(data.password);
      // Server tự đặt role/status/user_type — bỏ qua mọi giá trị client gửi kèm.
      const inserted = await pool.query(
        `INSERT INTO users (username, email, password_hash, role, display_name, full_name, organization, status, user_type)
         VALUES ($1, $2, $3, 'viewer', $4, $5, $6, 'pending', NULL)
         RETURNING id, created_at`,
        [
          username,
          email,
          passwordHash,
          data.displayName?.trim() || null,
          data.fullName.trim(),
          data.organization?.trim() || null
        ]
      );
      const newId = (inserted.rows[0] as { id: string }).id;
      request.log.info(
        { audit: 'user_registered', userId: newId, username, ip: request.ip },
        'user registered (pending approval)'
      );
      return reply.code(201).send({
        status: 'pending',
        message: 'Đã gửi đăng ký. Vui lòng chờ quản trị viên duyệt tài khoản.'
      });
    }
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: cfg.loginRateMax, timeWindow: cfg.loginRateWindowMs } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success || (!parsed.data.identifier && !parsed.data.email)) {
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }
      const identifier = normalizeIdentifier(parsed.data.identifier ?? parsed.data.email ?? '');
      const { password } = parsed.data;
      const ip = request.ip;

      // Đang bị khóa tạm: vẫn chạy xác minh giả để cân bằng thời gian, lỗi chung.
      const attempt = await getLoginAttempt(pool, identifier, ip);
      if (isLocked(attempt)) {
        await verifyPassword(await dummyPasswordHash(), password);
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }

      const result = await pool.query(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE lower(email) = $1 OR (username IS NOT NULL AND lower(username) = $1)`,
        [identifier]
      );
      const row = result.rows[0] as UserRow | undefined;
      if (!row) {
        // Định danh không tồn tại: xác minh giả + vẫn đếm khóa tạm.
        await verifyPassword(await dummyPasswordHash(), password);
        await recordLoginFailure(pool, identifier, ip, cfg.loginMaxFailed, cfg.loginLockMinutes);
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }
      if (!(await verifyPassword(row.password_hash, password))) {
        await recordLoginFailure(pool, identifier, ip, cfg.loginMaxFailed, cfg.loginLockMinutes);
        throw unauthorized(GENERIC_LOGIN_ERROR);
      }

      // Mật khẩu ĐÚNG từ đây — mới được lộ trạng thái tài khoản.
      await clearLoginAttempts(pool, identifier, ip);
      if (row.status === 'pending') {
        throw new AppError(
          403,
          'ACCOUNT_PENDING',
          'Tài khoản của bạn đang chờ quản trị viên duyệt. Vui lòng thử lại sau.'
        );
      }
      if (row.status !== 'active') {
        // rejected/disabled: thông báo chung, không lộ lý do nội bộ.
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Tài khoản không thể đăng nhập. Vui lòng liên hệ quản trị viên.');
      }

      const rawToken = await createSession(pool, row.id, cfg.sessionTtlDays);
      reply.setCookie(SESSION_COOKIE, rawToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.cookieSecure,
        path: '/',
        maxAge: cfg.sessionTtlDays * 24 * 60 * 60
      });
      return reply.send({ user: toCurrentUser(row) });
    }
  );

  app.post('/api/auth/change-password', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.');
    }
    const result = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [user.id]);
    const row = result.rows[0] as UserRow | undefined;
    if (!row || !(await verifyPassword(row.password_hash, parsed.data.currentPassword))) {
      throw unauthorized('Mật khẩu hiện tại không đúng');
    }
    const policy = checkPasswordPolicy(parsed.data.newPassword, {
      username: row.username,
      email: row.email
    });
    if (!policy.ok) throw badRequest(policy.code, policy.message);

    const passwordHash = await hashPassword(parsed.data.newPassword);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [passwordHash, user.id]
    );
    await deleteOtherSessions(pool, user.id, request.cookies[SESSION_COOKIE]);
    request.log.info({ audit: 'password_changed', userId: user.id }, 'password changed');
    return reply.send({ ok: true });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await deleteSession(pool, request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = await getCurrentUser(pool, request.cookies);
    if (!user) throw unauthorized();
    return reply.send({ user });
  });
}
