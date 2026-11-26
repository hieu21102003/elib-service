import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import {
  canDownload,
  canDownloadOriginal,
  type CurrentUser,
  type DocumentAccessRow,
  type UserRole
} from '../src/auth/session.js';
import { canPreview, canViewFull } from '../src/previews/permissions.js';
import { visibleInList } from '../src/documents/visibility.js';

/**
 * Quyền tải BẢN GỐC (canDownloadOriginal): CHỈ người tạo tài liệu hoặc admin.
 * Editor không phải người tạo, viewer nội bộ/ngoài, chưa đăng nhập đều bị
 * từ chối tải bản gốc — nhưng ma trận "thấy tài liệu" (danh sách + preview)
 * giữ nguyên như cũ. /view dùng chung quy tắc qua canViewFull.
 */

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const EDITOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const EXTERNAL_ID = '55555555-5555-4555-8555-555555555555';

function makeUser(
  role: UserRole,
  id: string,
  userType: CurrentUser['userType'] = 'internal'
): CurrentUser {
  return {
    id,
    username: null,
    email: `${role}-${id.slice(0, 4)}@congty.vn`,
    role,
    displayName: null,
    userType,
    status: 'active',
    mustChangePassword: false
  };
}

const owner = makeUser('viewer', OWNER_ID);
const ownerEditor = makeUser('editor', OWNER_ID);
const editorNonOwner = makeUser('editor', EDITOR_ID);
const admin = makeUser('admin', ADMIN_ID);
const internalViewer = makeUser('viewer', OTHER_ID, 'internal');
const externalViewer = makeUser('viewer', EXTERNAL_ID, 'external');

const doc = (status: string, visibility: string, created_by: string | null = OWNER_ID): DocumentAccessRow => ({
  status,
  visibility,
  created_by
});

describe('canDownloadOriginal — ma trận quyền tải bản gốc', () => {
  const visibilities = ['public', 'members', 'internal', 'private'];

  it('người tạo và admin tải được ở MỌI status/visibility', () => {
    for (const status of ['published', 'draft', 'hidden']) {
      for (const visibility of visibilities) {
        expect(canDownloadOriginal(owner, doc(status, visibility)), `chủ / ${status}+${visibility}`).toBe(true);
        expect(canDownloadOriginal(ownerEditor, doc(status, visibility)), `editor là chủ / ${status}+${visibility}`).toBe(true);
        expect(canDownloadOriginal(admin, doc(status, visibility)), `admin / ${status}+${visibility}`).toBe(true);
      }
    }
  });

  it('editor không phải người tạo, viewer nội bộ/ngoài, chưa đăng nhập KHÔNG tải được ở mọi tổ hợp', () => {
    for (const status of ['published', 'draft', 'hidden']) {
      for (const visibility of visibilities) {
        const d = doc(status, visibility);
        expect(canDownloadOriginal(editorNonOwner, d), `editor khác / ${status}+${visibility}`).toBe(false);
        expect(canDownloadOriginal(internalViewer, d), `viewer nội bộ / ${status}+${visibility}`).toBe(false);
        expect(canDownloadOriginal(externalViewer, d), `viewer ngoài / ${status}+${visibility}`).toBe(false);
        expect(canDownloadOriginal(null, d), `chưa đăng nhập / ${status}+${visibility}`).toBe(false);
      }
    }
  });

  it('tài khoản không active (kể cả là chủ hoặc admin) KHÔNG tải/xem toàn bộ được', () => {
    const disabledOwner: CurrentUser = { ...owner, status: 'disabled' };
    const disabledAdmin: CurrentUser = { ...admin, status: 'disabled' };
    const d = doc('published', 'members');
    expect(canDownloadOriginal(disabledOwner, d)).toBe(false);
    expect(canDownloadOriginal(disabledAdmin, d)).toBe(false);
    expect(canViewFull(disabledOwner, d)).toBe(false);
  });

  it('tài liệu không có người tạo (created_by NULL): chỉ admin', () => {
    const orphan = doc('published', 'public', null);
    expect(canDownloadOriginal(admin, orphan)).toBe(true);
    expect(canDownloadOriginal(owner, orphan)).toBe(false);
    expect(canDownloadOriginal(editorNonOwner, orphan)).toBe(false);
    expect(canDownloadOriginal(null, orphan)).toBe(false);
  });

  it('canViewFull (/view) dùng CHUNG quy tắc với canDownloadOriginal ở mọi tổ hợp', () => {
    const users: Array<CurrentUser | null> = [
      null,
      owner,
      ownerEditor,
      editorNonOwner,
      admin,
      internalViewer,
      externalViewer
    ];
    for (const user of users) {
      for (const status of ['published', 'draft', 'hidden']) {
        for (const visibility of visibilities) {
          for (const createdBy of [OWNER_ID, OTHER_ID, null]) {
            const d = doc(status, visibility, createdBy);
            expect(canViewFull(user, d)).toBe(canDownloadOriginal(user, d));
          }
        }
      }
    }
  });

  it('ma trận "thấy tài liệu" (danh sách/preview) và visibility=members: external thấy + preview, KHÔNG tải bản gốc/xem toàn bộ', () => {
    // Editor không phải người tạo vẫn thấy draft/internal trong danh sách + preview...
    expect(visibleInList(editorNonOwner, doc('draft', 'private'))).toBe(true);
    expect(canPreview(editorNonOwner, doc('published', 'internal'))).toBe(true);
    expect(visibleInList(internalViewer, doc('published', 'internal'))).toBe(true);
    expect(visibleInList(null, doc('published', 'public'))).toBe(true);
    // published + members: mọi tài khoản active (gồm external) thấy + preview, không tải được bản gốc/xem toàn bộ
    expect(visibleInList(null, doc('published', 'members'))).toBe(false);
    expect(canPreview(null, doc('published', 'members'))).toBe(false);
    expect(visibleInList(externalViewer, doc('published', 'members'))).toBe(true);
    expect(canPreview(externalViewer, doc('published', 'members'))).toBe(true);
    expect(canDownload(externalViewer, doc('published', 'members'))).toBe(true);
    expect(canDownloadOriginal(externalViewer, doc('published', 'members'))).toBe(false);
    expect(canViewFull(externalViewer, doc('published', 'members'))).toBe(false);
    expect(canDownloadOriginal(internalViewer, doc('published', 'members'))).toBe(false);
    expect(canDownloadOriginal(editorNonOwner, doc('published', 'members'))).toBe(false);
    expect(canDownloadOriginal(owner, doc('published', 'members'))).toBe(true);
    expect(canDownloadOriginal(admin, doc('published', 'members'))).toBe(true);
    // ...và canDownload (ma trận thấy) vẫn khớp visibleInList như trước...
    expect(canDownload(editorNonOwner, doc('published', 'public'))).toBe(true);
    // ...nhưng tải bản gốc thì KHÔNG.
    expect(canDownloadOriginal(editorNonOwner, doc('published', 'public'))).toBe(false);
    expect(canDownloadOriginal(null, doc('published', 'public'))).toBe(false);
  });
});

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
    // Route tải bản gốc: WHERE d.id = $1 AND f.id = $2 — kiểm tra TRƯỚC nhánh chung.
    if (s.includes('AND f.id = $2')) {
      const row = this.docs.get(String(params[0]));
      if (!row || row.file_id !== String(params[1])) return { rows: [] };
      return { rows: [{ ...row }] };
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

describe('route tải bản gốc + can_download trong danh sách (FakePool + storage thật)', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  const cookies: Record<string, string> = {};

  const ORIGINAL = Buffer.from('ORIGINAL-BYTES-BAN-GOC');

  const USERS = { owner, editorNonOwner, admin, internalViewer, externalViewer };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-download-'));
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

  async function addDoc(overrides: Record<string, unknown> = {}): Promise<{ docId: string; fileId: string }> {
    const docId = randomUUID();
    const fileId = randomUUID();
    const originalPath = storage.buildOriginalPath(docId, 1, fileId, 'pdf');
    await storage.saveBytes(ORIGINAL, originalPath);
    pool.docs.set(docId, {
      doc_id: docId,
      status: 'published',
      visibility: 'public',
      created_by: OWNER_ID,
      file_id: fileId,
      storage_path: originalPath,
      original_filename: 'tai-lieu.pdf',
      mime_type: 'application/pdf',
      file_size: String(ORIGINAL.length),
      ...overrides
    });
    return { docId, fileId };
  }

  const get = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const downloadUrl = (docId: string, fileId: string) =>
    `/api/documents/${docId}/files/${fileId}/download`;

  it('người tạo tải được bản gốc (200, đúng bytes, attachment)', async () => {
    const { docId, fileId } = await addDoc();
    const res = await get(downloadUrl(docId, fileId), cookies.owner);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ORIGINAL.toString());
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('admin tải được bản gốc của tài liệu người khác (200)', async () => {
    const { docId, fileId } = await addDoc({ visibility: 'private' });
    const res = await get(downloadUrl(docId, fileId), cookies.admin);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(ORIGINAL.toString());
  });

  it('editor không phải người tạo -> 403 DOWNLOAD_FORBIDDEN (kể cả tài liệu public)', async () => {
    const { docId, fileId } = await addDoc();
    const res = await get(downloadUrl(docId, fileId), cookies.editorNonOwner);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DOWNLOAD_FORBIDDEN');
    expect(res.body).not.toContain('ORIGINAL-BYTES');
  });

  it('viewer nội bộ -> 403 DOWNLOAD_FORBIDDEN', async () => {
    const { docId, fileId } = await addDoc({ visibility: 'internal' });
    const res = await get(downloadUrl(docId, fileId), cookies.internalViewer);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DOWNLOAD_FORBIDDEN');
  });

  it('viewer ngoài -> 403 DOWNLOAD_FORBIDDEN (kể cả tài liệu members)', async () => {
    const { docId, fileId } = await addDoc({ visibility: 'members' });
    const res = await get(downloadUrl(docId, fileId), cookies.externalViewer);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DOWNLOAD_FORBIDDEN');
  });

  it('tài liệu members: chủ và admin tải được bản gốc; editor khác và viewer nội bộ -> 403 DOWNLOAD_FORBIDDEN', async () => {
    const { docId, fileId } = await addDoc({ visibility: 'members' });
    expect((await get(downloadUrl(docId, fileId), cookies.owner)).statusCode).toBe(200);
    expect((await get(downloadUrl(docId, fileId), cookies.admin)).statusCode).toBe(200);
    expect((await get(downloadUrl(docId, fileId), cookies.editorNonOwner)).statusCode).toBe(403);
    expect((await get(downloadUrl(docId, fileId), cookies.internalViewer)).statusCode).toBe(403);
    expect((await get(downloadUrl(docId, fileId))).statusCode).toBe(401);
  });

  it('chưa đăng nhập -> 401 (quy ước cũ của route tải), không lộ bytes', async () => {
    const { docId, fileId } = await addDoc();
    const res = await get(downloadUrl(docId, fileId));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(res.body).not.toContain('ORIGINAL-BYTES');
  });

  it('tài liệu/file không tồn tại hoặc id sai định dạng -> 404 NOT_FOUND thống nhất', async () => {
    const { docId } = await addDoc();
    const missing = await get(downloadUrl(randomUUID(), randomUUID()), cookies.owner);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');

    const wrongFile = await get(downloadUrl(docId, randomUUID()), cookies.owner);
    expect(wrongFile.statusCode).toBe(404);

    const badId = await get('/api/documents/khong-phai-uuid/files/cung-khong-phai/download', cookies.owner);
    expect(badId.statusCode).toBe(404);
  });

  it('danh sách: can_download theo người dùng (chủ/admin true; còn lại false), can_view_full giữ nguyên', async () => {
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
    expect(asOwner.json().data[0].can_download).toBe(true);
    expect(asOwner.json().data[0].can_view_full).toBe(true);

    const asAdmin = await get('/api/documents', cookies.admin);
    expect(asAdmin.json().data[0].can_download).toBe(true);
    expect(asAdmin.json().data[0].can_view_full).toBe(true);

    const asEditor = await get('/api/documents', cookies.editorNonOwner);
    expect(asEditor.json().data[0].can_download).toBe(false);
    expect(asEditor.json().data[0].can_view_full).toBe(false);

    const asInternalViewer = await get('/api/documents', cookies.internalViewer);
    expect(asInternalViewer.json().data[0].can_download).toBe(false);

    const asExternalViewer = await get('/api/documents', cookies.externalViewer);
    expect(asExternalViewer.json().data[0].can_download).toBe(false);

    const asAnon = await get('/api/documents');
    expect(asAnon.json().data[0].can_download).toBe(false);
    expect(asAnon.json().data[0].can_view_full).toBe(false);

    // Tài liệu members: can_download / can_view_full vẫn chỉ chủ + admin.
    pool.listRows[0].visibility = 'members';
    expect((await get('/api/documents', cookies.owner)).json().data[0].can_download).toBe(true);
    expect((await get('/api/documents', cookies.admin)).json().data[0].can_download).toBe(true);
    expect((await get('/api/documents', cookies.externalViewer)).json().data[0].can_download).toBe(false);
    expect((await get('/api/documents', cookies.externalViewer)).json().data[0].can_view_full).toBe(false);
    expect((await get('/api/documents', cookies.internalViewer)).json().data[0].can_download).toBe(false);
    expect((await get('/api/documents', cookies.editorNonOwner)).json().data[0].can_download).toBe(false);
  });
});
