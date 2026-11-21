import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { unauthorized } from '../errors.js';
import { verifyPassword } from '../auth/password.js';
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  userFromSessionToken,
  type CurrentUser
} from '../auth/session.js';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

export async function getCurrentUser(
  pool: pg.Pool,
  cookies: Record<string, string | undefined>
): Promise<CurrentUser | null> {
  return userFromSessionToken(pool, cookies[SESSION_COOKIE]);
}

export function registerAuthRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AppConfig): void {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw unauthorized('Email hoặc mật khẩu không đúng');
    }
    const { email, password } = parsed.data;
    const result = await pool.query(
      'SELECT id, email, password_hash, role, display_name FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    const row = result.rows[0] as
      | { id: string; email: string; password_hash: string; role: string; display_name: string | null }
      | undefined;
    if (!row || !(await verifyPassword(row.password_hash, password))) {
      throw unauthorized('Email hoặc mật khẩu không đúng');
    }
    const rawToken = await createSession(pool, row.id, cfg.sessionTtlDays);
    reply.setCookie(SESSION_COOKIE, rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.cookieSecure,
      path: '/',
      maxAge: cfg.sessionTtlDays * 24 * 60 * 60
    });
    return reply.send({
      user: { id: row.id, email: row.email, role: row.role, displayName: row.display_name }
    });
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
