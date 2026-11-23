import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomInt } from 'node:crypto';

/** Băm mật khẩu bằng argon2id (@node-rs/argon2, có bản dựng sẵn cho Linux). */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}

/**
 * Hash giả để chạy xác minh argon2 khi username/email không tồn tại,
 * cân bằng thời gian phản hồi với trường hợp sai mật khẩu (chống dò tài khoản).
 * Được tính lười ở lần dùng đầu tiên và dùng lại.
 */
let dummyHashPromise: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hash(randomBytes(32).toString('base64url'));
  return dummyHashPromise;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Danh sách mật khẩu phổ biến bị chặn (so khớp không phân biệt hoa thường). */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  '1234567', '123456', '12345', '1234', '111111', '11111111', '000000', '00000000',
  'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcd1234', 'a123456', '1q2w3e4r',
  '1q2w3e', 'qazwsx', 'zxcvbnm', 'iloveyou', 'admin', 'admin123', 'administrator',
  'letmein', 'welcome', 'welcome1', 'login', 'root', 'toor', 'changeme', 'default',
  'secret', 'sunshine', 'princess', 'football', 'baseball', 'dragon', 'monkey',
  'shadow', 'master', 'superman', 'batman', 'trustno1', 'starwars', 'whatever',
  'freedom', 'hello123', 'world123', 'computer', 'internet', 'samsung', 'google',
  'matkhau', 'matkhau1', 'matkhau123', '123456a', 'a1234567', '123123', '112233',
  '654321', '123321', '123qwe', 'qwe123', 'qweasd', '1qaz2wsx', 'zxcvbn', 'asdfgh',
  'asdfghjkl', 'password!', 'p@ssw0rd', 'p@ssword', 'pass123', 'test123', 'demo123',
  'user123', 'guest', 'guest123', '123456789a', '87654321', '111111111', '12345678910'
]);

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; code: 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON' | 'PASSWORD_EQUALS_IDENTITY'; message: string };

/**
 * Kiểm tra chính sách mật khẩu: 8–128 ký tự, không thuộc danh sách phổ biến,
 * không trùng username hoặc phần trước @ của email (không phân biệt hoa thường).
 */
export function checkPasswordPolicy(
  password: string,
  identity: { username?: string | null; email?: string | null } = {}
): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_SHORT',
      message: `Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_LONG',
      message: `Mật khẩu không được dài quá ${PASSWORD_MAX_LENGTH} ký tự.`
    };
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_COMMON',
      message: 'Mật khẩu này quá phổ biến, vui lòng chọn mật khẩu khác khó đoán hơn.'
    };
  }
  const username = identity.username?.trim().toLowerCase();
  const emailLocal = identity.email?.split('@')[0]?.trim().toLowerCase();
  if ((username && lower === username) || (emailLocal && lower === emailLocal)) {
    return {
      ok: false,
      code: 'PASSWORD_EQUALS_IDENTITY',
      message: 'Mật khẩu không được trùng với tên đăng nhập hoặc email.'
    };
  }
  return { ok: true };
}

/** Sinh mật khẩu tạm ngẫu nhiên (admin đặt lại) — thỏa chính sách mật khẩu. */
export function generateTemporaryPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}
