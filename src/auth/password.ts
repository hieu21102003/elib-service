import { hash, verify } from '@node-rs/argon2';

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
