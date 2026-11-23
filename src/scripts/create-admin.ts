import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { hashPassword } from '../auth/password.js';

/**
 * Tạo tài khoản admin đầu tiên (không có trang đăng ký).
 * Cách dùng:
 *   npm run create-admin -- --email admin@congty.vn --password 'MatKhauManh' --name 'Quản trị'
 * Hoặc qua biến môi trường: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME.
 * Thêm --force để cập nhật mật khẩu/role nếu email đã tồn tại.
 */
function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const email = (argValue('--email') ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = argValue('--password') ?? process.env.ADMIN_PASSWORD ?? '';
const displayName = argValue('--name') ?? process.env.ADMIN_NAME ?? null;
const force = process.argv.includes('--force');

if (!email || !password) {
  console.error('Thiếu email/mật khẩu. Ví dụ: npm run create-admin -- --email admin@congty.vn --password "MatKhauManh"');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Mật khẩu phải có ít nhất 8 ký tự.');
  process.exit(1);
}

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const existing = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  const passwordHash = await hashPassword(password);
  if (existing.rows.length > 0) {
    if (!force) {
      console.error(`Email ${email} đã tồn tại. Thêm --force nếu muốn cập nhật mật khẩu và đặt lại role admin.`);
      process.exit(1);
    }
    await pool.query(
      "UPDATE users SET password_hash = $1, role = 'admin', status = 'active', user_type = 'internal', display_name = COALESCE($2, display_name), updated_at = now() WHERE id = $3",
      [passwordHash, displayName, existing.rows[0].id]
    );
    console.log(`Đã cập nhật tài khoản admin: ${email}`);
  } else {
    await pool.query(
      "INSERT INTO users (email, password_hash, role, display_name, status, user_type) VALUES ($1,$2,'admin',$3,'active','internal')",
      [email, passwordHash, displayName]
    );
    console.log(`Đã tạo tài khoản admin: ${email}`);
  }
} finally {
  await pool.end();
}
