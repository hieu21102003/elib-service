import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { visibleInList } from '../src/documents/visibility.js';
import type { CurrentUser, UserRole } from '../src/auth/session.js';

/**
 * Test route /preview + /view bằng app.inject với FakePool (không cần
 * PostgreSQL thật) và storage thật trong thư mục tạm. FakePool mô phỏng
 * đúng các câu SQL mà route dùng: tra session, tra tài liệu + file mới
 * nhất, đếm + liệt kê danh sách.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const EDITOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const EXTERNAL_ID = '55555555-5555-4555-8555-555555555555';
const DISABLED_ID = '66666666-6666-4666-8666-666666666666';

function makeUser(
  role: UserRole,
  id: string,
  userType: CurrentUser['userType'] = 'internal',
  status: CurrentUser['status'] = 'active'
): CurrentUser {
  return {
    id,
    username: null,
    email: `${role}-${id.slice(0, 4)}@congty.vn`,
    role,
    displayName: null,
    userType,
    status,
    mustChangePassword: false
  };
}

const USERS = {
  owner: makeUser('viewer', OWNER_ID),
  externalViewer: makeUser('viewer', EXTERNAL_ID, 'external'),
  otherViewer: makeUser('viewer', OTHER_ID, 'internal'),
  editor: makeUser('editor', EDITOR_ID),
  admin: makeUser('admin', ADMIN_ID),
  disabledUser: makeUser('viewer', DISABLED_ID, 'internal', 'disabled')
};

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

class FakePool {
  tokens = new Map<string, CurrentUser>();
  docs = new Map<string, Record<string, unknown>>();
  listRows: Record<string, unknown>[] = [];

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
          ? [{
              id: user.id,
              username: user.username,
              email: user.email,
              role: user.role,
              display_name: user.displayName,
              status: user.status,
              user_type: user.userType,
              must_change_password: user.mustChangePassword
            }]
          : []
      };
    }
    if (s.includes('WHERE d.id = $1')) {
      const row = this.docs.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (s.includes('COUNT(*)::int AS total')) {
      return { rows: [{ total: this.listRows.length }] };
    }
    if (s.includes('FROM documents d')) {
      return { rows: this.listRows.map((r) => ({ ...r })) };
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

describe('route xem trước / xem toàn bộ (FakePool + storage thật)', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  const cookies: Record<string, string> = {};

  const ORIGINAL = Buffer.from('ORIGINAL-BYTES-KHONG-DUOC-LO');
  const PREVIEW = Buffer.from('PREVIEW-BYTES-DA-CAT-TRANG');

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-routes-'));
    storage = new LocalDiskStorage(root);
    pool = new FakePool();
    for (const [key, user] of Object.entries(USERS)) {
      cookies[key] = `elib_session=${pool.addUser(user)}`;
    }
    app = await createApp({
      pool: pool.asPool(),
      storage,
      config: { ...loadConfig(), logLevel: 'silent' }
    });
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function addDoc(overrides: Record<string, unknown> = {}): Promise<string> {
    const docId = randomUUID();
    const fileId = randomUUID();
    const originalPath = storage.buildOriginalPath(docId, 1, fileId, 'pdf');
    const previewPath = storage.buildPreviewPath(docId, 1);
    await storage.saveBytes(ORIGINAL, originalPath);
    await storage.saveBytes(PREVIEW, previewPath);
    pool.docs.set(docId, {
      doc_id: docId,
      status: 'published',
      visibility: 'public',
      created_by: OWNER_ID,
      file_id: fileId,
      version: 1,
      storage_path: originalPath,
      original_filename: 'tai-lieu.pdf',
      mime_type: 'application/pdf',
      file_size: String(ORIGINAL.length),
      checksum_sha256: 'a'.repeat(64),
      page_count: 10,
      preview_path: previewPath,
      preview_pages: 2,
      preview_status: 'ready',
      ...overrides
    });
    return docId;
  }

  const get = (url: string, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers }
    });

  it('preview trả bytes của file xem trước, KHÔNG phải bytes gốc', async () => {
    const docId = await addDoc();
    const res = await get(`/api/documents/${docId}/preview`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body).toBe(PREVIEW.toString());
    expect(res.body).not.toContain('ORIGINAL-BYTES');
  });

  it('ma trận quyền preview khớp visibleInList ở mọi tổ hợp (gồm members × anonymous/external/internal/editor/chủ/admin)', async () => {
    const actors: Array<{ label: string; user: CurrentUser | null; cookie?: string }> = [
      { label: 'anonymous', user: null },
      { label: 'external', user: USERS.externalViewer, cookie: cookies.externalViewer },
      { label: 'internal viewer', user: USERS.otherViewer, cookie: cookies.otherViewer },
      { label: 'editor', user: USERS.editor, cookie: cookies.editor },
      { label: 'chủ', user: USERS.owner, cookie: cookies.owner },
      { label: 'admin', user: USERS.admin, cookie: cookies.admin }
    ];
    for (const status of ['published', 'draft', 'hidden']) {
      for (const visibility of ['public', 'members', 'internal', 'private']) {
        const docId = await addDoc({ status, visibility });
        for (const actor of actors) {
          const allowed = visibleInList(actor.user, {
            status,
            visibility,
            created_by: OWNER_ID
          });
          const res = await get(`/api/documents/${docId}/preview`, actor.cookie);
          if (allowed) {
            expect(res.statusCode, `${actor.label} / ${status}+${visibility}`).toBe(200);
          } else if (actor.user === null) {
            // Chưa đăng nhập: 404 thống nhất, không lộ sự tồn tại.
            expect(res.statusCode, `${actor.label} / ${status}+${visibility}`).toBe(404);
            expect(res.json().error.code).toBe('NOT_FOUND');
          } else {
            expect(res.statusCode, `${actor.label} / ${status}+${visibility}`).toBe(403);
          }
        }
      }
    }
  });

  it('anonymous: tài liệu members/internal/private và tài liệu không tồn tại đều 404 NOT_FOUND như nhau', async () => {
    const membersId = await addDoc({ visibility: 'members' });
    const internalId = await addDoc({ visibility: 'internal' });
    const privateId = await addDoc({ visibility: 'private' });
    const missingId = randomUUID();
    const resMembers = await get(`/api/documents/${membersId}/preview`);
    const resInternal = await get(`/api/documents/${internalId}/preview`);
    const resPrivate = await get(`/api/documents/${privateId}/preview`);
    const resMissing = await get(`/api/documents/${missingId}/preview`);
    for (const r of [resMembers, resInternal, resPrivate, resMissing]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
    }
    // /view cũng 404 cho anonymous với members/internal/private.
    expect((await get(`/api/documents/${membersId}/view`)).statusCode).toBe(404);
    expect((await get(`/api/documents/${internalId}/view`)).statusCode).toBe(404);
    expect((await get(`/api/documents/${privateId}/view`)).statusCode).toBe(404);
    // id không phải UUID cũng 404.
    const c = await get('/api/documents/khong-phai-uuid/preview');
    expect(c.statusCode).toBe(404);
  });

  it('tài khoản status=disabled (cookie cũ) không xem được preview tài liệu members -> 404 NOT_FOUND', async () => {
    const membersId = await addDoc({ visibility: 'members' });
    const res = await get(`/api/documents/${membersId}/preview`, cookies.disabledUser);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('tài liệu members: external/internal/editor xem preview (private, no-store) nhưng bị /view 403; chủ/admin xem /view 200', async () => {
    const membersId = await addDoc({ visibility: 'members' });
    for (const cookie of [cookies.externalViewer, cookies.otherViewer, cookies.editor]) {
      const prev = await get(`/api/documents/${membersId}/preview`, cookie);
      expect(prev.statusCode).toBe(200);
      expect(prev.body).toBe(PREVIEW.toString());
      expect(prev.body).not.toContain('ORIGINAL-BYTES');
      expect(prev.headers['cache-control']).toBe('private, no-store');
      expect(prev.headers.etag).toBeUndefined();

      const full = await get(`/api/documents/${membersId}/view`, cookie);
      expect(full.statusCode).toBe(403);
    }
    expect((await get(`/api/documents/${membersId}/view`, cookies.owner)).statusCode).toBe(200);
    expect((await get(`/api/documents/${membersId}/view`, cookies.admin)).statusCode).toBe(200);
  });

  it('/view: chỉ chủ + admin; editor và viewer khác bị từ chối; anonymous 404', async () => {
    const docId = await addDoc();
    const ownerRes = await get(`/api/documents/${docId}/view`, cookies.owner);
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.body).toBe(ORIGINAL.toString());
    expect(ownerRes.headers['content-disposition']).toContain('inline');
    expect(ownerRes.headers['cache-control']).toBe('private, no-store');

    const adminRes = await get(`/api/documents/${docId}/view`, cookies.admin);
    expect(adminRes.statusCode).toBe(200);

    const editorRes = await get(`/api/documents/${docId}/view`, cookies.editor);
    expect(editorRes.statusCode).toBe(403);

    const viewerRes = await get(`/api/documents/${docId}/view`, cookies.otherViewer);
    expect(viewerRes.statusCode).toBe(403);

    const anonRes = await get(`/api/documents/${docId}/view`);
    expect(anonRes.statusCode).toBe(404);
    expect(anonRes.json().error.code).toBe('NOT_FOUND');
  });

  it('tài liệu 1 trang: người không có quyền toàn bộ không nhận được preview', async () => {
    const docId = await addDoc({
      page_count: 1,
      preview_pages: null,
      preview_path: null,
      preview_status: 'unsupported'
    });
    const res = await get(`/api/documents/${docId}/preview`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PREVIEW_NOT_AVAILABLE');
    // Chủ tài liệu vẫn xem toàn bộ được qua /view.
    const full = await get(`/api/documents/${docId}/view`, cookies.owner);
    expect(full.statusCode).toBe(200);
  });

  it('ảnh (không phải PDF) -> 415 PREVIEW_UNSUPPORTED', async () => {
    const docId = await addDoc({
      mime_type: 'image/png',
      preview_status: 'unsupported',
      preview_path: null,
      preview_pages: null,
      page_count: null
    });
    const res = await get(`/api/documents/${docId}/preview`);
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('PREVIEW_UNSUPPORTED');
  });

  it('preview chưa sẵn sàng (pending/failed) -> 404 PREVIEW_NOT_READY, không fallback sang bản gốc', async () => {
    for (const status of ['pending', 'processing', 'failed']) {
      const docId = await addDoc({ preview_status: status, preview_path: null, preview_pages: null });
      const res = await get(`/api/documents/${docId}/preview`);
      expect(res.statusCode, status).toBe(404);
      expect(res.json().error.code).toBe('PREVIEW_NOT_READY');
      expect(res.body).not.toContain('ORIGINAL-BYTES');
    }
  });

  it('header cache: public được cache + ETag/304; internal là private, no-store', async () => {
    const publicId = await addDoc();
    const res = await get(`/api/documents/${publicId}/preview`);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const etag = res.headers.etag;
    expect(etag).toContain('-v1-p2');
    const notModified = await get(`/api/documents/${publicId}/preview`, undefined, {
      'if-none-match': String(etag)
    });
    expect(notModified.statusCode).toBe(304);

    const internalId = await addDoc({ visibility: 'internal' });
    const internalRes = await get(`/api/documents/${internalId}/preview`, cookies.otherViewer);
    expect(internalRes.statusCode).toBe(200);
    expect(internalRes.headers['cache-control']).toBe('private, no-store');
    expect(internalRes.headers.etag).toBeUndefined();
  });

  it('danh sách: có page_count/preview_pages/preview_status và can_view_full theo người dùng', async () => {
    const now = new Date();
    pool.listRows = [
      {
        id: randomUUID(),
        title: 'Tai lieu test',
        slug: 'tai-lieu-test',
        description: null,
        category_id: null,
        doc_type: null,
        language: null,
        visibility: 'public',
        status: 'published',
        price: null,
        created_by: OWNER_ID,
        created_at: now,
        updated_at: now,
        file_id: randomUUID(),
        file_document_id: randomUUID(),
        file_version: 1,
        original_filename: 'a.pdf',
        mime_type: 'application/pdf',
        file_size: '1234',
        page_count: 10,
        preview_pages: 2,
        preview_status: 'ready',
        file_created_at: now,
        category_ref_id: null,
        category_name: null,
        tag_names: []
      }
    ];

    const asOwner = await get('/api/documents', cookies.owner);
    expect(asOwner.statusCode).toBe(200);
    const item = asOwner.json().data[0];
    expect(item.can_view_full).toBe(true);
    expect(item.file.page_count).toBe(10);
    expect(item.file.preview_pages).toBe(2);
    expect(item.file.preview_status).toBe('ready');
    expect(item.file).not.toHaveProperty('preview_path');
    expect(item.file).not.toHaveProperty('storage_path');

    const asEditor = await get('/api/documents', cookies.editor);
    expect(asEditor.json().data[0].can_view_full).toBe(false);

    const asAdmin = await get('/api/documents', cookies.admin);
    expect(asAdmin.json().data[0].can_view_full).toBe(true);

    const asAnon = await get('/api/documents');
    expect(asAnon.json().data[0].can_view_full).toBe(false);
  });
});
