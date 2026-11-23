-- elib-service Giai đoạn A3 — đăng ký tài khoản + duyệt admin + user_type.
-- Chạy lại an toàn (IF NOT EXISTS / DROP INDEX IF EXISTS). Trước khi chạy trên
-- tecco1, liệt kê tài khoản cũ để kiểm tra:
--   SELECT username, role, created_at FROM users ORDER BY created_at;
-- (cột username chỉ có sau migration này; trước đó dùng email thay cho username)
-- Các tài khoản cũ sẽ được đặt status='active', user_type='internal'.

-- Tên đăng nhập (NULL với tài khoản cũ — đăng nhập bằng email như trước).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;

-- Trạng thái tài khoản: pending (chờ duyệt) | active | rejected | disabled.
-- DEFAULT 'active' để tài khoản cũ và script tạo admin tự active.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending', 'active', 'rejected', 'disabled'));

-- internal = người công ty, external = khách ngoài; NULL khi mới đăng ký,
-- admin bắt buộc chọn khi duyệt.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type text
  CHECK (user_type IN ('internal', 'external'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reject_reason text;

-- Bắt buộc đổi mật khẩu ở lần đăng nhập kế tiếp (admin đặt lại mật khẩu).
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Tài khoản có trước migration: coi là người nội bộ đã kích hoạt.
UPDATE users SET user_type = 'internal' WHERE user_type IS NULL;

-- Unique không phân biệt hoa thường cho username (chỉ khi có username).
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
  ON users (lower(username)) WHERE username IS NOT NULL;

-- Email unique không phân biệt hoa thường, NHƯNG email của tài khoản bị từ chối
-- (rejected) được giải phóng để đăng ký lại: thay index cũ bằng partial index.
DROP INDEX IF EXISTS users_email_lower_idx;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (lower(email)) WHERE status <> 'rejected';

CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

-- Đếm đăng nhập sai theo (định danh + IP) để khóa tạm, kể cả định danh
-- không tồn tại (chống dò tài khoản). identifier = username/email đã chuẩn
-- hóa (NFC, trim, chữ thường).
CREATE TABLE IF NOT EXISTS login_attempts (
  identifier text NOT NULL,
  ip text NOT NULL,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identifier, ip)
);
