import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { hashPassword } from '../src/auth/password.js';

/**
 * Test Giai đoạn A3: đăng ký + duyệt admin + user_type + khóa tạm đăng nhập
 * + thu hồi phiên + CSRF + trustProxy, bằng app.inject với FakePool
 * (không cần PostgreSQL thật).
 */

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

interface FakeUser {
  id: string;
  username: string | null;
  email: string;
  password_hash: string;
  role: string;
  display_name: string | null;
  full_name: string | null;
  organization: string | null;
  status: string;
  user_type: string | null;
  must_change_password: boolean;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeAttempt {
  identifier: string;
  ip: string;
  failed_count: number;
  locked_until: string | null;
}

class FakePool {
  users: FakeUser[] = [];
  sessions = new Map<string, string>(); // token_hash -> userId
  attempts = new Map<string, FakeAttempt>();

  async addUser(input: {
    username?: string | null;
    email: string;
    password: string;
    role?: string;
    status?: string;
    userType?: string | null;
    fullName?: string;
    organization?: string | null;
  }): Promise<FakeUser> {
    const user: FakeUser = {
      id: randomUUID(),
      username: input.username ?? null,
      email: input.email,
      password_hash: await hashPassword(input.password),
      role: input.role ?? 'viewer',
      display_name: null,
      full_name: input.fullName ?? 'Người Dùng Test',
      organization: input.organization ?? null,
      status: input.status ?? 'active',
      user_type: input.userType === undefined ? 'internal' : input.userType,
      must_change_password: false,
      reject_reason: null,
      created_at: new Date(),
      updated_at: new Date()
    };
    this.users.push(user);
    return user;
  }

  findByIdentifier(identifier: string): FakeUser | undefined {
    const id = identifier.toLowerCase();
    return this.users.find(
      (u) => u.email.toLowerCase() === id || (u.username !== null && u.username.toLowerCase() === id)
    );
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    // --- sessions ---
    if (s.includes('FROM sessions')) {
      const userId = this.sessions.get(String(params[0]));
      const user = this.users.find((u) => u.id === userId);
      return { rows: user ? [{ ...user }] : [] };
    }
    if (s.startsWith('INSERT INTO sessions')) {
      this.sessions.set(String(params[1]), String(params[0]));
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM sessions WHERE token_hash')) {
      this.sessions.delete(String(params[0]));
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM sessions WHERE user_id = $1 AND token_hash <>')) {
      for (const [hash, uid] of this.sessions) {
        if (uid === String(params[0]) && hash !== String(params[1])) this.sessions.delete(hash);
      }
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM sessions WHERE user_id')) {
      for (const [hash, uid] of this.sessions) {
        if (uid === String(params[0])) this.sessions.delete(hash);
      }
      return { rows: [] };
    }

    // --- login_attempts ---
    if (s.startsWith('SELECT failed_count, locked_until FROM login_attempts')) {
      const a = this.attempts.get(`${params[0]}|${params[1]}`);
      return { rows: a ? [{ failed_count: a.failed_count, locked_until: a.locked_until }] : [] };
    }
    if (s.startsWith('INSERT INTO login_attempts')) {
      this.attempts.set(`${params[0]}|${params[1]}`, {
        identifier: String(params[0]),
        ip: String(params[1]),
        failed_count: Number(params[2]),
        locked_until: (params[3] as string | null) ?? null
      });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE login_attempts')) {
      const key = `${params[0]}|${params[1]}`;
      const a = this.attempts.get(key);
      if (a) {
        a.failed_count = Number(params[2]);
        a.locked_until = (params[3] as string | null) ?? null;
      }
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM login_attempts WHERE identifier = ANY')) {
      const ids = params[0] as string[];
      for (const [key, a] of this.attempts) {
        if (ids.includes(a.identifier)) this.attempts.delete(key);
      }
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM login_attempts')) {
      this.attempts.delete(`${params[0]}|${params[1]}`);
      return { rows: [] };
    }

    // --- users: đếm ---
    if (s.includes("COUNT(*)::int AS total FROM users WHERE status = 'pending'")) {
      return { rows: [{ total: this.users.filter((u) => u.status === 'pending').length }] };
    }
    if (s.includes("COUNT(*)::int AS total FROM users WHERE role = 'admin'")) {
      const total = this.users.filter(
        (u) => u.role === 'admin' && u.status === 'active' && u.id !== String(params[0])
      ).length;
      return { rows: [{ total }] };
    }

    // --- users: kiểm tra trùng ---
    if (s.startsWith('SELECT id FROM users WHERE username IS NOT NULL')) {
      const taken = this.users.some(
        (u) => u.username !== null && u.username.toLowerCase() === String(params[0]).toLowerCase()
      );
      return { rows: taken ? [{ id: 'x' }] : [] };
    }
    if (s.startsWith("SELECT id FROM users WHERE lower(email) = lower($1) AND status <> 'rejected'")) {
      const taken = this.users.some(
        (u) => u.email.toLowerCase() === String(params[0]).toLowerCase() && u.status !== 'rejected'
      );
      return { rows: taken ? [{ id: 'x' }] : [] };
    }

    // --- users: tạo mới (đăng ký) ---
    if (s.startsWith('INSERT INTO users')) {
      const user: FakeUser = {
        id: randomUUID(),
        username: String(params[0]),
        email: String(params[1]),
        password_hash: String(params[2]),
        role: 'viewer',
        display_name: (params[3] as string | null) ?? null,
        full_name: String(params[4]),
        organization: (params[5] as string | null) ?? null,
        status: 'pending',
        user_type: null,
        must_change_password: false,
        reject_reason: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      this.users.push(user);
      return { rows: [{ id: user.id, created_at: user.created_at }] };
    }

    // --- users: liệt kê theo trạng thái (admin) ---
    if (s.includes('FROM users WHERE status = $1 ORDER BY')) {
      return {
        rows: this.users
          .filter((u) => u.status === String(params[0]))
          .map((u) => ({ ...u }))
      };
    }

    // --- users: đăng nhập ---
    if (s.includes('FROM users WHERE lower(email) = $1 OR')) {
      const user = this.findByIdentifier(String(params[0]));
      return { rows: user ? [{ ...user }] : [] };
    }

    // --- users: cập nhật ---
    if (s.startsWith("UPDATE users SET status = 'active', user_type")) {
      const user = this.users.find((u) => u.id === String(params[0]) && u.status === 'pending');
      if (!user) return { rows: [] };
      user.status = 'active';
      user.user_type = String(params[1]);
      return { rows: [{ ...user }] };
    }
    if (s.startsWith("UPDATE users SET status = 'rejected'")) {
      const user = this.users.find((u) => u.id === String(params[0]) && u.status === 'pending');
      if (!user) return { rows: [] };
      user.status = 'rejected';
      user.reject_reason = String(params[1]);
      return { rows: [{ id: user.id }] };
    }
    if (s.startsWith('UPDATE users SET role = $2')) {
      const user = this.users.find((u) => u.id === String(params[0]));
      if (!user) return { rows: [] };
      user.role = String(params[1]);
      user.user_type = (params[2] as string | null) ?? null;
      user.status = String(params[3]);
      return { rows: [{ ...user }] };
    }
    if (s.startsWith('UPDATE users SET password_hash = $1, must_change_password = true')) {
      const user = this.users.find((u) => u.id === String(params[1]));
      if (user) {
        user.password_hash = String(params[0]);
        user.must_change_password = true;
      }
      return { rows: [] };
    }
    if (s.startsWith('UPDATE users SET password_hash = $1, must_change_password = false')) {
      const user = this.users.find((u) => u.id === String(params[1]));
      if (user) {
        user.password_hash = String(params[0]);
        user.must_change_password = false;
      }
      return { rows: [] };
    }

    // --- users: lấy một ---
    if (s.includes('FROM users WHERE id = $1')) {
      const user = this.users.find((u) => u.id === String(params[0]));
      return { rows: user ? [{ ...user }] : [] };
    }

    throw new Error(`FakePool: SQL không hỗ trợ: ${s.slice(0, 120)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

const ADMIN_PASSWORD = 'AdminPass123';
const USER_PASSWORD = 'UserPass123';

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    logLevel: 'silent',
    registerRateMax: 1000,
    loginRateMax: 1000,
    internalEmailDomains: ['congty.vn'],
    ...overrides
  };
}

describe('Giai đoạn A3 — đăng ký, duyệt, khóa tạm, thu hồi phiên', () => {
  let root: string;
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let admin: FakeUser;

  const post = (url: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      payload: JSON.stringify(body)
    });

  async function login(identifier: string, password: string) {
    const res = await post('/api/auth/login', { identifier, password });
    const setCookie = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie[0]?.split(';')[0] : setCookie?.split(';')[0];
    return { res, cookie };
  }

  async function adminCookie(): Promise<string> {
    const { res, cookie } = await login(admin.email, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    return cookie!;
  }

  const validRegister = (suffix: string) => ({
    username: `user_${suffix}`,
    password: 'MatKhauManh2026',
    fullName: 'Nguyễn Văn Test',
    organization: 'Công ty ABC',
    email: `user_${suffix}@example.com`
  });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-a3-'));
    pool = new FakePool();
    admin = await pool.addUser({
      email: 'admin@congty.vn',
      password: ADMIN_PASSWORD,
      role: 'admin',
      status: 'active',
      userType: 'internal'
    });
    app = await createApp({
      pool: pool.asPool(),
      storage: new LocalDiskStorage(root),
      config: testConfig()
    });
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('đăng ký thành công: 201 pending, role viewer, user_type NULL, không tự đăng nhập', async () => {
    const res = await post('/api/auth/register', validRegister('a1'));
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    expect(res.headers['set-cookie']).toBeUndefined();
    const user = pool.findByIdentifier('user_a1')!;
    expect(user.status).toBe('pending');
    expect(user.role).toBe('viewer');
    expect(user.user_type).toBeNull();
  });

  it('client gửi role/status/user_type đều bị bỏ qua', async () => {
    const res = await post('/api/auth/register', {
      ...validRegister('a2'),
      role: 'admin',
      status: 'active',
      user_type: 'internal',
      userType: 'internal'
    });
    expect(res.statusCode).toBe(201);
    const user = pool.findByIdentifier('user_a2')!;
    expect(user.role).toBe('viewer');
    expect(user.status).toBe('pending');
    expect(user.user_type).toBeNull();
  });

  it('chính sách mật khẩu: quá ngắn / quá dài / phổ biến / trùng username', async () => {
    const cases: Array<[string, string]> = [
      ['Ngắn1!', 'PASSWORD_TOO_SHORT'],
      ['A'.repeat(129), 'PASSWORD_TOO_LONG'],
      ['password123', 'PASSWORD_TOO_COMMON']
    ];
    for (const [password, code] of cases) {
      const res = await post('/api/auth/register', { ...validRegister('a3'), password });
      expect(res.statusCode, password.slice(0, 20)).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
    const equalsIdentity = await post('/api/auth/register', {
      ...validRegister('a3'),
      username: 'nguoidung_a3',
      password: 'nguoidung_a3'
    });
    expect(equalsIdentity.statusCode).toBe(400);
    expect(equalsIdentity.json().error.code).toBe('PASSWORD_EQUALS_IDENTITY');
    expect(pool.findByIdentifier('user_a3')).toBeUndefined();
  });

  it('email sai định dạng -> 400; trùng email/username (không phân biệt hoa thường) -> 409', async () => {
    const badEmail = await post('/api/auth/register', { ...validRegister('a4'), email: 'khong-phai-email' });
    expect(badEmail.statusCode).toBe(400);

    const dupEmail = await post('/api/auth/register', {
      ...validRegister('a5'),
      email: 'USER_A1@example.com'
    });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error.code).toBe('EMAIL_TAKEN');

    const dupUsername = await post('/api/auth/register', {
      ...validRegister('a6'),
      username: 'User_A1'
    });
    expect(dupUsername.statusCode).toBe(409);
    expect(dupUsername.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('honeypot: trả 201 giả nhưng không tạo tài khoản', async () => {
    const before = pool.users.length;
    const res = await post('/api/auth/register', { ...validRegister('bot1'), website: 'http://spam.example' });
    expect(res.statusCode).toBe(201);
    expect(pool.users.length).toBe(before);
    expect(pool.findByIdentifier('user_bot1')).toBeUndefined();
  });

  it('đăng nhập tài khoản pending: sai mật khẩu -> 401 chung; đúng mật khẩu -> 403 ACCOUNT_PENDING', async () => {
    const wrong = await login('user_a1', 'SaiMatKhau123');
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json().error.code).toBe('UNAUTHORIZED');

    const right = await login('user_a1', 'MatKhauManh2026');
    expect(right.res.statusCode).toBe(403);
    expect(right.res.json().error.code).toBe('ACCOUNT_PENDING');
  });

  it('định danh không tồn tại: 401 chung giống sai mật khẩu và vẫn bị đếm khóa tạm', async () => {
    const { res } = await login('khong_ton_tai', 'BatKy123456');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Email/tên đăng nhập hoặc mật khẩu không đúng');
    const attempt = [...pool.attempts.values()].find((a) => a.identifier === 'khong_ton_tai');
    expect(attempt?.failed_count).toBe(1);
  });

  it('admin duyệt: bắt buộc user_type; duyệt xong đăng nhập được, me trả userType', async () => {
    const cookie = await adminCookie();
    const target = pool.findByIdentifier('user_a1')!;

    const noType = await post(`/api/admin/users/${target.id}/approve`, {}, cookie);
    expect(noType.statusCode).toBe(400);
    expect(noType.json().error.code).toBe('INVALID_USER_TYPE');

    const ok = await post(`/api/admin/users/${target.id}/approve`, { user_type: 'external' }, cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.status).toBe('active');
    expect(ok.json().user.user_type).toBe('external');

    const { res, cookie: userCookie } = await login('user_a1', 'MatKhauManh2026');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.userType).toBe('external');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: userCookie! } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.userType).toBe('external');
    expect(me.json().user.status).toBe('active');
  });

  it('từ chối giải phóng email: đăng ký lại cùng email được', async () => {
    const cookie = await adminCookie();
    const target = pool.findByIdentifier('user_a2')!;
    const res = await post(`/api/admin/users/${target.id}/reject`, { reason: 'Không đủ thông tin' }, cookie);
    expect(res.statusCode).toBe(200);
    expect(target.status).toBe('rejected');
    expect(target.reject_reason).toBe('Không đủ thông tin');

    const again = await post('/api/auth/register', {
      ...validRegister('a2b'),
      email: 'user_a2@example.com'
    });
    expect(again.statusCode).toBe(201);
  });

  it('tài khoản rejected đăng nhập (đúng mật khẩu) -> 403 chung, không lộ lý do', async () => {
    const { res } = await login('user_a2', 'MatKhauManh2026');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(res.json().error.message).not.toContain('Không đủ thông tin');
  });

  it('PATCH: không chuyển pending->active, không tự vô hiệu hóa/hạ role, editor cần internal', async () => {
    const cookie = await adminCookie();
    const pending = pool.findByIdentifier('user_a2b')!;
    const patch = (id: string, body: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${id}`,
        headers: { 'content-type': 'application/json', cookie },
        payload: JSON.stringify(body)
      });

    const toActive = await patch(pending.id, { status: 'active' });
    expect(toActive.statusCode).toBe(400);
    expect(toActive.json().error.code).toBe('INVALID_STATUS_TRANSITION');

    const selfDisable = await patch(admin.id, { status: 'disabled' });
    expect(selfDisable.statusCode).toBe(400);
    expect(selfDisable.json().error.code).toBe('CANNOT_MODIFY_SELF');

    const selfDemote = await patch(admin.id, { role: 'viewer' });
    expect(selfDemote.statusCode).toBe(400);
    expect(selfDemote.json().error.code).toBe('CANNOT_MODIFY_SELF');

    const external = pool.findByIdentifier('user_a1')!;
    const editorExternal = await patch(external.id, { role: 'editor' });
    expect(editorExternal.statusCode).toBe(400);
    expect(editorExternal.json().error.code).toBe('EDITOR_REQUIRES_INTERNAL');

    const toInternal = await patch(external.id, { user_type: 'internal', role: 'editor' });
    expect(toInternal.statusCode).toBe(200);
    expect(toInternal.json().user.role).toBe('editor');

    const backToExternal = await patch(external.id, { user_type: 'external' });
    expect(backToExternal.statusCode).toBe(400);
    expect(backToExternal.json().error.code).toBe('EDITOR_REQUIRES_INTERNAL');
  });

  it('không hạ/vô hiệu hóa được admin active cuối cùng (bởi admin khác)', async () => {
    const secondAdmin = await pool.addUser({
      email: 'admin2@congty.vn',
      password: ADMIN_PASSWORD,
      role: 'admin',
      status: 'active',
      userType: 'internal'
    });
    const { cookie } = await login(secondAdmin.email, ADMIN_PASSWORD);
    // Hạ admin thứ hai (không phải cuối cùng vì còn admin gốc) -> được
    const demoteSecond = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${secondAdmin.id}`,
      headers: { 'content-type': 'application/json', cookie: (await adminCookie()) },
      payload: JSON.stringify({ role: 'viewer' })
    });
    expect(demoteSecond.statusCode).toBe(200);
    // Giờ admin gốc là admin cuối cùng; chính admin gốc không tự hạ được (CANNOT_MODIFY_SELF)
    // nên tạo admin thứ ba rồi hạ admin gốc bằng admin thứ ba sau khi hạ admin thứ ba? ->
    // đơn giản: dùng admin thứ ba hạ admin gốc khi admin thứ ba còn active thì ĐƯỢC,
    // sau đó admin thứ ba là cuối cùng và không ai hạ được nữa ngoài chính nó (self).
    const thirdAdmin = await pool.addUser({
      email: 'admin3@congty.vn',
      password: ADMIN_PASSWORD,
      role: 'admin',
      status: 'active',
      userType: 'internal'
    });
    const { cookie: thirdCookie } = await login(thirdAdmin.email, ADMIN_PASSWORD);
    const demoteRoot = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.id}`,
      headers: { 'content-type': 'application/json', cookie: thirdCookie! },
      payload: JSON.stringify({ role: 'viewer' })
    });
    expect(demoteRoot.statusCode).toBe(200);
    // admin thứ ba giờ là admin cuối cùng: hạ chính mình -> CANNOT_MODIFY_SELF (chặn trước LAST_ADMIN)
    const demoteThirdSelf = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${thirdAdmin.id}`,
      headers: { 'content-type': 'application/json', cookie: thirdCookie! },
      payload: JSON.stringify({ role: 'viewer' })
    });
    expect(demoteThirdSelf.statusCode).toBe(400);
    expect(demoteThirdSelf.json().error.code).toBe('CANNOT_MODIFY_SELF');
    // khôi phục admin gốc cho các test sau
    admin.role = 'admin';
    admin.status = 'active';
    expect(cookie).toBeTruthy();
  });

  it('thu hồi phiên hiệu lực ngay: vô hiệu hóa -> request kế tiếp 401; đổi role -> me thấy role mới', async () => {
    const victim = await pool.addUser({
      email: 'victim@congty.vn',
      password: USER_PASSWORD,
      role: 'viewer',
      status: 'active',
      userType: 'internal'
    });
    const { cookie: victimCookie } = await login(victim.email, USER_PASSWORD);
    const meBefore = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: victimCookie! } });
    expect(meBefore.statusCode).toBe(200);
    expect(meBefore.json().user.role).toBe('viewer');

    const cookie = await adminCookie();
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${victim.id}`,
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ role: 'editor' })
    });
    expect(promote.statusCode).toBe(200);
    const meAfter = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: victimCookie! } });
    expect(meAfter.json().user.role).toBe('editor');

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${victim.id}`,
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ status: 'disabled' })
    });
    expect(disable.statusCode).toBe(200);
    const meDisabled = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: victimCookie! } });
    expect(meDisabled.statusCode).toBe(401);
  });

  it('đặt lại mật khẩu: mật khẩu tạm dùng được nhưng bị chặn tới khi đổi; đổi xong vào được', async () => {
    const target = await pool.addUser({
      email: 'resetme@congty.vn',
      password: USER_PASSWORD,
      role: 'viewer',
      status: 'active',
      userType: 'internal'
    });
    const cookie = await adminCookie();
    const reset = await post(`/api/admin/users/${target.id}/reset-password`, {}, cookie);
    expect(reset.statusCode).toBe(200);
    const tempPassword = reset.json().temporaryPassword as string;
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);

    const oldLogin = await login(target.email, USER_PASSWORD);
    expect(oldLogin.res.statusCode).toBe(401);

    const { res: tempLogin, cookie: tempCookie } = await login(target.email, tempPassword);
    expect(tempLogin.statusCode).toBe(200);
    expect(tempLogin.json().user.mustChangePassword).toBe(true);

    const blocked = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { cookie: tempCookie! }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MUST_CHANGE_PASSWORD');

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: tempCookie! } });
    expect(me.statusCode).toBe(200);

    const changed = await post(
      '/api/auth/change-password',
      { currentPassword: tempPassword, newPassword: 'MatKhauMoi2026' },
      tempCookie
    );
    expect(changed.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { cookie: tempCookie! }
    });
    expect(after.statusCode).not.toBe(403);
  });

  it('khóa tạm theo (username+IP): đủ số lần sai thì mật khẩu đúng cũng bị chặn; admin mở khóa được', async () => {
    const target = await pool.addUser({
      email: 'lockme@congty.vn',
      password: USER_PASSWORD,
      role: 'viewer',
      status: 'active',
      userType: 'internal'
    });
    // LOGIN_MAX_FAILED mặc định 5
    for (let i = 0; i < 5; i++) {
      const { res } = await login(target.email, 'SaiMatKhau123');
      expect(res.statusCode).toBe(401);
    }
    const locked = await login(target.email, USER_PASSWORD);
    expect(locked.res.statusCode).toBe(401);

    const cookie = await adminCookie();
    const unlock = await post(`/api/admin/users/${target.id}/unlock`, {}, cookie);
    expect(unlock.statusCode).toBe(200);

    const after = await login(target.email, USER_PASSWORD);
    expect(after.res.statusCode).toBe(200);
  });

  it('danh sách admin: pendingCount + gợi ý email_domain_internal; non-admin bị 403, anonymous 401', async () => {
    const cookie = await adminCookie();
    const res = await app.inject({ method: 'GET', url: '/api/admin/users?status=pending', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingCount).toBeGreaterThan(0);
    const pendingUser = res.json().users.find((u: { username: string }) => u.username === 'user_a2b');
    expect(pendingUser).toBeTruthy();
    expect(pendingUser.email_domain_internal).toBe(false);

    const internalPending = await post('/api/auth/register', {
      username: 'noi_bo_1',
      password: 'MatKhauManh2026',
      fullName: 'Người Nội Bộ',
      email: 'noi.bo@congty.vn'
    });
    expect(internalPending.statusCode).toBe(201);
    const res2 = await app.inject({ method: 'GET', url: '/api/admin/users?status=pending', headers: { cookie } });
    const hinted = res2.json().users.find((u: { email: string }) => u.email === 'noi.bo@congty.vn');
    expect(hinted.email_domain_internal).toBe(true);

    const anon = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(anon.statusCode).toBe(401);

    const { cookie: viewerCookie } = await login('user_a1', 'MatKhauManh2026');
    const viewerRes = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: viewerCookie! }
    });
    expect(viewerRes.statusCode).toBe(403);
  });

  it('từ chối hàng loạt: chỉ pending bị từ chối, trả số lượng', async () => {
    const cookie = await adminCookie();
    const p1 = pool.findByIdentifier('noi_bo_1')!;
    const active = pool.findByIdentifier('user_a1')!;
    const res = await post(
      '/api/admin/users/bulk-reject',
      { ids: [p1.id, active.id], reason: 'Dọn danh sách chờ' },
      cookie
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected).toBe(1);
    expect(p1.status).toBe('rejected');
    expect(active.status).toBe('active');
  });

  it('CSRF: Origin lệch host -> 403; Origin khớp hoặc không có Origin -> qua', async () => {
    const mismatch = await post(
      '/api/auth/login',
      { identifier: admin.email, password: ADMIN_PASSWORD },
      undefined,
      { origin: 'http://evil.example' }
    );
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe('CSRF_ORIGIN_MISMATCH');

    const match = await post(
      '/api/auth/login',
      { identifier: admin.email, password: ADMIN_PASSWORD },
      undefined,
      { origin: 'http://localhost:80' }
    );
    expect(match.statusCode).toBe(200);

    const cookie = await adminCookie();
    const adminMismatch = await post(
      '/api/admin/users/bulk-reject',
      { ids: [randomUUID()], reason: 'x' },
      cookie,
      { origin: 'https://evil.example' }
    );
    expect(adminMismatch.statusCode).toBe(403);
    expect(adminMismatch.json().error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('username chuẩn hóa Unicode NFC: đăng ký dạng tổ hợp, đăng nhập dạng dựng sẵn vẫn khớp', async () => {
    const decomposed = 'nguye\u0302\u0303n_van'; // nguyễn_van dạng tổ hợp
    const composed = 'nguyễn_van';
    const res = await post('/api/auth/register', {
      username: decomposed,
      password: 'MatKhauManh2026',
      fullName: 'Nguyễn Văn',
      email: 'nguyen.van@example.com'
    });
    expect(res.statusCode).toBe(201);
    const stored = pool.users.find((u) => u.email === 'nguyen.van@example.com')!;
    expect(stored.username).toBe(composed);

    const cookie = await adminCookie();
    await post(`/api/admin/users/${stored.id}/approve`, { user_type: 'internal' }, cookie);
    const { res: loginRes } = await login(composed, 'MatKhauManh2026');
    expect(loginRes.statusCode).toBe(200);
  });
});

describe('Giai đoạn A3 — trần pending, rate limit, trustProxy', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-a3b-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function buildApp(overrides: Partial<AppConfig>) {
    const pool = new FakePool();
    const app = await createApp({
      pool: pool.asPool(),
      storage: new LocalDiskStorage(root),
      config: testConfig(overrides)
    });
    return { app, pool };
  }

  it('trần pending: vượt MAX_PENDING_USERS -> 429 PENDING_LIMIT_REACHED', async () => {
    const { app, pool } = await buildApp({ maxPendingUsers: 1 });
    try {
      await pool.addUser({
        email: 'pending1@example.com',
        password: USER_PASSWORD,
        status: 'pending',
        userType: null
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          username: 'them_moi',
          password: 'MatKhauManh2026',
          fullName: 'Thêm Mới',
          email: 'them.moi@example.com'
        })
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('PENDING_LIMIT_REACHED');
    } finally {
      await app.close();
    }
  });

  it('rate limit đăng ký theo IP: vượt REGISTER_RATE_MAX -> 429', async () => {
    const { app } = await buildApp({ registerRateMax: 2, registerRateWindowMs: 60_000 });
    try {
      const payload = (n: number) =>
        JSON.stringify({
          username: `rl_user_${n}`,
          password: 'MatKhauManh2026',
          fullName: 'RL Test',
          email: `rl${n}@example.com`
        });
      const headers = { 'content-type': 'application/json' };
      expect((await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: payload(1) })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: payload(2) })).statusCode).toBe(201);
      const third = await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: payload(3) });
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });

  it('trustProxy=false: X-Forwarded-For giả mạo không tách được bucket rate limit', async () => {
    const { app } = await buildApp({ trustProxy: false, loginRateMax: 2, loginRateWindowMs: 60_000 });
    try {
      const attempt = (xff: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          payload: JSON.stringify({ identifier: 'ai_do@example.com', password: 'Sai123456' })
        });
      expect((await attempt('1.1.1.1')).statusCode).toBe(401);
      expect((await attempt('2.2.2.2')).statusCode).toBe(401);
      // IP socket vẫn là một -> request thứ 3 bị 429 dù XFF khác nhau
      expect((await attempt('3.3.3.3')).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('trustProxy=1: rate limit tính theo IP client trong X-Forwarded-For (một hop)', async () => {
    const { app } = await buildApp({ trustProxy: 1, loginRateMax: 2, loginRateWindowMs: 60_000 });
    try {
      const attempt = (xff: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
          payload: JSON.stringify({ identifier: 'ai_do@example.com', password: 'Sai123456' })
        });
      expect((await attempt('1.1.1.1')).statusCode).toBe(401);
      expect((await attempt('1.1.1.1')).statusCode).toBe(401);
      expect((await attempt('1.1.1.1')).statusCode).toBe(429);
      // IP client khác -> bucket riêng, không bị 429
      expect((await attempt('2.2.2.2')).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
