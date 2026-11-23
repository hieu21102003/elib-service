import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import type { CurrentUser, UserRole } from '../src/auth/session.js';

/**
 * Test PATCH /api/documents/:id (đổi visibility) bằng app.inject với
 * FakePool (không cần PostgreSQL thật). FakePool mô phỏng đúng các câu
 * SQL route dùng: tra session, tra tài liệu theo id, UPDATE visibility.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const EDITOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';

function makeUser(role: UserRole, id: string): CurrentUser {
  return { id, email: `${role}-${id.slice(0, 4)}@congty.vn`, role, displayName: null };
}

const USERS = {
  owner: makeUser('viewer', OWNER_ID),
  otherViewer: makeUser('viewer', OTHER_ID),
  editor: makeUser('editor', EDITOR_ID),
  admin: makeUser('admin', ADMIN_ID)
};

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

interface FakeDoc {
  id: string;
  title: string;
  visibility: string;
  status: string;
  created_by: string | null;
  updated_at: Date;
}

class FakePool {
  tokens = new Map<string, CurrentUser>();
  docs = new Map<string, FakeDoc>();

  addUser(user: CurrentUser): string {
    const raw = `token-${user.id}`;
    this.tokens.set(hashToken(raw), user);
    return raw;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM sessions')) {
      const user = this.tokens.get(String(params[0]));
      return {
        rows: user
          ? [{ id: user.id, email: user.email, role: user.role, display_name: user.displayName }]
          : []
      };
    }
    if (s.startsWith('UPDATE documents SET visibility')) {
      const doc = this.docs.get(String(params[1]));
      if (!doc) return { rows: [] };
      doc.visibility = String(params[0]);
      doc.updated_at = new Date();
      return {
        rows: [
          {
            id: doc.id,
            title: doc.title,
            visibility: doc.visibility,
            status: doc.status,
            updated_at: doc.updated_at
          }
        ]
      };
    }
    if (s.includes('FROM documents WHERE id = $1')) {
      const doc = this.docs.get(String(params[0]));
      return {
        rows: doc
          ? [
              {
                id: doc.id,
                title: doc.title,
                visibility: doc.visibility,
                status: doc.status,
                created_by: doc.created_by
              }
            ]
          : []
      };
    }
    throw new Error(`FakePool: SQL không hỗ trợ: ${s.slice(0, 100)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

describe('PATCH /api/documents/:id — đổi visibility (FakePool)', () => {
  let root: string;
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-visibility-'));
    pool = new FakePool();
    for (const [key, user] of Object.entries(USERS)) {
      cookies[key] = `elib_session=${pool.addUser(user)}`;
    }
    app = await createApp({
      pool: pool.asPool(),
      storage: new LocalDiskStorage(root),
      config: { ...loadConfig(), logLevel: 'silent' }
    });
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function addDoc(overrides: Partial<FakeDoc> = {}): string {
    const id = randomUUID();
    pool.docs.set(id, {
      id,
      title: 'Tài liệu test',
      visibility: 'internal',
      status: 'published',
      created_by: OWNER_ID,
      updated_at: new Date(),
      ...overrides
    });
    return id;
  }

  const patch = (id: string, body: unknown, cookie?: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/documents/${id}`,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      payload: JSON.stringify(body)
    });

  it('admin đổi được visibility của tài liệu bất kỳ', async () => {
    const id = addDoc();
    const res = await patch(id, { visibility: 'public' }, cookies.admin);
    expect(res.statusCode).toBe(200);
    const doc = res.json().document;
    expect(doc.id).toBe(id);
    expect(doc.visibility).toBe('public');
    expect(doc.updated_at).toBeTruthy();
    expect(pool.docs.get(id)?.visibility).toBe('public');
  });

  it('người tạo đổi được visibility của tài liệu của mình', async () => {
    const id = addDoc();
    const res = await patch(id, { visibility: 'private' }, cookies.owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().document.visibility).toBe('private');
    expect(pool.docs.get(id)?.visibility).toBe('private');
  });

  it('editor không phải người tạo bị 403, visibility không đổi', async () => {
    const id = addDoc();
    const res = await patch(id, { visibility: 'public' }, cookies.editor);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(pool.docs.get(id)?.visibility).toBe('internal');
  });

  it('viewer khác bị 403', async () => {
    const id = addDoc();
    const res = await patch(id, { visibility: 'public' }, cookies.otherViewer);
    expect(res.statusCode).toBe(403);
    expect(pool.docs.get(id)?.visibility).toBe('internal');
  });

  it('chưa đăng nhập bị 401', async () => {
    const id = addDoc();
    const res = await patch(id, { visibility: 'public' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(pool.docs.get(id)?.visibility).toBe('internal');
  });

  it('visibility không hợp lệ bị 400 INVALID_VISIBILITY', async () => {
    const id = addDoc();
    for (const body of [{ visibility: 'cong-khai' }, { visibility: '' }, {}, { visibility: 123 }]) {
      const res = await patch(id, body, cookies.admin);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_VISIBILITY');
    }
    expect(pool.docs.get(id)?.visibility).toBe('internal');
  });

  it('tài liệu không tồn tại -> 404; id không phải UUID -> 404', async () => {
    const missing = await patch(randomUUID(), { visibility: 'public' }, cookies.admin);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');

    const badId = await patch('khong-phai-uuid', { visibility: 'public' }, cookies.admin);
    expect(badId.statusCode).toBe(404);
  });

  it('đổi sang đúng giá trị hiện tại vẫn 200 (idempotent)', async () => {
    const id = addDoc({ visibility: 'public' });
    const res = await patch(id, { visibility: 'public' }, cookies.owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().document.visibility).toBe('public');
  });

  it('không đổi được status qua endpoint này (trường lạ bị bỏ qua, status giữ nguyên)', async () => {
    const id = addDoc({ status: 'draft' });
    const res = await patch(id, { visibility: 'public', status: 'published' }, cookies.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().document.status).toBe('draft');
    expect(pool.docs.get(id)?.status).toBe('draft');
  });
});
