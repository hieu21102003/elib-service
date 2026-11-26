import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import {
  canDownload,
  type CurrentUser,
  type DocumentAccessRow,
  type UserRole
} from '../src/auth/session.js';
import { visibleDocumentsWhere, visibleInList } from '../src/documents/visibility.js';
import { escapeLikeKeyword, searchPredicate } from '../src/documents/search.js';
import {
  clampLimit,
  parseDocumentListQuery,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN
} from '../src/documents/list-query.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function makeUser(
  role: UserRole,
  id = OWNER_ID,
  userType: CurrentUser['userType'] = 'internal',
  status: CurrentUser['status'] = 'active'
): CurrentUser {
  return {
    id,
    username: null,
    email: `${role}@congty.vn`,
    role,
    displayName: null,
    userType,
    status,
    mustChangePassword: false
  };
}

describe('ma trận quyền danh sách — visibleInList phải khớp canDownload ở MỌI tổ hợp', () => {
  const users: Array<{ label: string; user: CurrentUser | null }> = [
    { label: 'chưa đăng nhập', user: null },
    { label: 'viewer', user: makeUser('viewer') },
    { label: 'editor', user: makeUser('editor') },
    { label: 'admin', user: makeUser('admin') }
  ];
  const visibilities = ['public', 'members', 'internal', 'private'];
  const statuses = ['published', 'draft', 'hidden'];

  it('đối chiếu đủ 96 tổ hợp: 4 vai trò × người tạo/không phải × 4 visibility × 3 status', () => {
    let combos = 0;
    for (const { label, user } of users) {
      for (const isOwner of [true, false]) {
        for (const visibility of visibilities) {
          for (const status of statuses) {
            const doc: DocumentAccessRow = {
              status,
              visibility,
              created_by: isOwner ? OWNER_ID : OTHER_ID
            };
            expect(
              visibleInList(user, doc),
              `${label} / ${isOwner ? 'người tạo' : 'không phải người tạo'} / ${status}+${visibility}`
            ).toBe(canDownload(user, doc));
            combos++;
          }
        }
      }
    }
    expect(combos).toBe(96);
  });

  it('đối chiếu thêm chiều user_type: external/NULL vẫn khớp canDownload ở mọi tổ hợp', () => {
    const typedUsers: Array<{ label: string; user: CurrentUser }> = [
      { label: 'viewer external', user: makeUser('viewer', OWNER_ID, 'external') },
      { label: 'viewer user_type NULL', user: makeUser('viewer', OWNER_ID, null) },
      { label: 'editor external', user: makeUser('editor', OWNER_ID, 'external') },
      { label: 'admin external', user: makeUser('admin', OWNER_ID, 'external') }
    ];
    for (const { label, user } of typedUsers) {
      for (const isOwner of [true, false]) {
        for (const visibility of visibilities) {
          for (const status of statuses) {
            const doc: DocumentAccessRow = {
              status,
              visibility,
              created_by: isOwner ? OWNER_ID : OTHER_ID
            };
            expect(
              visibleInList(user, doc),
              `${label} / ${isOwner ? 'người tạo' : 'không phải người tạo'} / ${status}+${visibility}`
            ).toBe(canDownload(user, doc));
          }
        }
      }
    }
  });

  it('tài khoản status khác active (pending/disabled/rejected) chỉ thấy published+public, không thấy members/internal/private/draft/hidden', () => {
    const inactiveStatuses: Array<CurrentUser['status']> = ['pending', 'disabled', 'rejected'];
    for (const st of inactiveStatuses) {
      for (const role of ['viewer', 'editor', 'admin'] as const) {
        const user = makeUser(role, OWNER_ID, 'internal', st);
        expect(visibleDocumentsWhere(user).params).toEqual([null, null, null]);
        for (const isOwner of [true, false]) {
          for (const visibility of visibilities) {
            for (const status of statuses) {
              const doc: DocumentAccessRow = {
                status,
                visibility,
                created_by: isOwner ? OWNER_ID : OTHER_ID
              };
              const expected = status === 'published' && visibility === 'public';
              expect(
                visibleInList(user, doc),
                `status=${st} / ${role} / ${isOwner ? 'owner' : 'other'} / ${status}+${visibility}`
              ).toBe(expected);
              expect(canDownload(user, doc)).toBe(expected);
            }
          }
        }
      }
    }
  });

  it('các ô tiêu biểu của ma trận (gồm chiều members)', () => {
    const viewer = makeUser('viewer');
    const externalViewer = makeUser('viewer', OWNER_ID, 'external');
    const unassignedViewer = makeUser('viewer', OWNER_ID, null);
    const editor = makeUser('editor');
    const admin = makeUser('admin');
    const doc = (status: string, visibility: string, created_by: string): DocumentAccessRow => ({
      status,
      visibility,
      created_by
    });
    // published + public: mọi người
    expect(visibleInList(null, doc('published', 'public', OTHER_ID))).toBe(true);
    // published + members: mọi tài khoản đã đăng nhập & status=active (gồm external, internal, editor, chủ, admin); chưa đăng nhập -> false
    expect(visibleInList(null, doc('published', 'members', OTHER_ID))).toBe(false);
    expect(visibleInList(externalViewer, doc('published', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(viewer, doc('published', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(unassignedViewer, doc('published', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(editor, doc('published', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(makeUser('viewer', OWNER_ID, 'external'), doc('published', 'members', OWNER_ID))).toBe(true);
    expect(visibleInList(admin, doc('published', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(makeUser('viewer', OTHER_ID, 'external', 'pending'), doc('published', 'members', OTHER_ID))).toBe(false);
    expect(visibleInList(makeUser('viewer', OTHER_ID, 'external', 'disabled'), doc('published', 'members', OTHER_ID))).toBe(false);
    // draft/hidden + members: viewer không thấy (trừ chủ), editor/admin thấy
    expect(visibleInList(externalViewer, doc('draft', 'members', OTHER_ID))).toBe(false);
    expect(visibleInList(viewer, doc('hidden', 'members', OTHER_ID))).toBe(false);
    expect(visibleInList(editor, doc('draft', 'members', OTHER_ID))).toBe(true);
    expect(visibleInList(admin, doc('hidden', 'members', OTHER_ID))).toBe(true);
    // published + internal: chỉ người nội bộ hoặc editor/admin
    expect(visibleInList(null, doc('published', 'internal', OTHER_ID))).toBe(false);
    expect(visibleInList(viewer, doc('published', 'internal', OTHER_ID))).toBe(true);
    expect(visibleInList(externalViewer, doc('published', 'internal', OTHER_ID))).toBe(false);
    expect(canDownload(externalViewer, doc('published', 'internal', OTHER_ID))).toBe(false);
    expect(visibleInList(externalViewer, doc('published', 'public', OTHER_ID))).toBe(true);
    expect(visibleInList(unassignedViewer, doc('published', 'internal', OTHER_ID))).toBe(false);
    // editor/admin vẫn thấy internal dù user_type external (role quyết định)
    expect(visibleInList(makeUser('editor', OWNER_ID, 'external'), doc('published', 'internal', OTHER_ID))).toBe(true);
    expect(visibleInList(makeUser('admin', OWNER_ID, 'external'), doc('published', 'internal', OTHER_ID))).toBe(true);
    // published + private: người tạo hoặc admin (editor không phải người tạo thì KHÔNG)
    expect(visibleInList(editor, doc('published', 'private', OTHER_ID))).toBe(false);
    expect(visibleInList(editor, doc('published', 'private', OWNER_ID))).toBe(true);
    expect(visibleInList(admin, doc('published', 'private', OTHER_ID))).toBe(true);
    expect(visibleInList(viewer, doc('published', 'private', OTHER_ID))).toBe(false);
    // draft/hidden: người tạo, editor, admin (viewer không bao giờ, kể cả public)
    expect(visibleInList(viewer, doc('draft', 'public', OTHER_ID))).toBe(false);
    expect(visibleInList(viewer, doc('hidden', 'public', OWNER_ID))).toBe(true);
    expect(visibleInList(editor, doc('draft', 'private', OTHER_ID))).toBe(true);
    expect(visibleInList(null, doc('draft', 'public', OTHER_ID))).toBe(false);
  });
});

describe('visibleDocumentsWhere — mảnh SQL lọc quyền', () => {
  it('chưa đăng nhập: params [null, null, null], SQL chứa đủ 5 mệnh đề', () => {
    const frag = visibleDocumentsWhere(null);
    expect(frag.params).toEqual([null, null, null]);
    expect(frag.sql).toContain("d.status = 'published' AND d.visibility = 'public'");
    expect(frag.sql).toContain("d.status = 'published' AND d.visibility = 'members' AND $1::uuid IS NOT NULL");
    expect(frag.sql).toContain("d.visibility = 'internal' AND $1::uuid IS NOT NULL AND ($3::text = 'internal' OR $2::text IN ('editor', 'admin'))");
    expect(frag.sql).toContain("d.visibility = 'private' AND ($1::uuid = d.created_by OR $2::text = 'admin')");
    expect(frag.sql).toContain("d.status IN ('draft', 'hidden') AND ($1::uuid = d.created_by OR $2::text IN ('editor', 'admin'))");
  });

  it('đã đăng nhập: params [userId, role, userType]', () => {
    expect(visibleDocumentsWhere(makeUser('viewer')).params).toEqual([OWNER_ID, 'viewer', 'internal']);
    expect(visibleDocumentsWhere(makeUser('editor')).params).toEqual([OWNER_ID, 'editor', 'internal']);
    expect(visibleDocumentsWhere(makeUser('admin')).params).toEqual([OWNER_ID, 'admin', 'internal']);
    expect(visibleDocumentsWhere(makeUser('viewer', OWNER_ID, 'external')).params).toEqual([OWNER_ID, 'viewer', 'external']);
  });

  it('đánh số tham số từ startParam và dùng alias tùy chọn', () => {
    const frag = visibleDocumentsWhere(makeUser('admin'), 3, 'documents');
    expect(frag.sql).toContain('$3::uuid IS NOT NULL');
    expect(frag.sql).toContain("$5::text = 'internal'");
    expect(frag.sql).toContain("$4::text = 'admin'");
    expect(frag.sql).toContain('documents.status');
    expect(frag.sql).not.toContain('$1');
  });
});

describe('escapeLikeKeyword + searchPredicate — tìm kiếm không dấu', () => {
  it('escape %, _ và \\ theo nghĩa đen', () => {
    expect(escapeLikeKeyword('100%')).toBe('100\\%');
    expect(escapeLikeKeyword('a_b')).toBe('a\\_b');
    expect(escapeLikeKeyword('a\\b')).toBe('a\\\\b');
    expect(escapeLikeKeyword('50%_x\\')).toBe('50\\%\\_x\\\\');
    expect(escapeLikeKeyword('đường sắt')).toBe('đường sắt');
    expect(escapeLikeKeyword('')).toBe('');
  });

  it('từ khóa trống (chỉ khoảng trắng) -> không có điều kiện tìm kiếm', () => {
    expect(searchPredicate(undefined, 1)).toBeNull();
    expect(searchPredicate('', 1)).toBeNull();
    expect(searchPredicate('   ', 1)).toBeNull();
  });

  it('từ khóa thường: bọc %...%, dùng f_unaccent + ESCAPE, tìm cả trong thẻ', () => {
    const frag = searchPredicate('đường sắt', 3);
    expect(frag).not.toBeNull();
    expect(frag!.params).toEqual(['%đường sắt%']);
    expect(frag!.sql).toContain('f_unaccent(lower(d.title)) LIKE f_unaccent(lower($3))');
    expect(frag!.sql).toContain("f_unaccent(lower(COALESCE(d.description, '')))");
    expect(frag!.sql).toContain('EXISTS');
    expect(frag!.sql).toContain('document_tags');
    expect(frag!.sql).toContain("ESCAPE '\\'");
  });

  it('từ khóa chứa % và _ được escape trước khi bọc', () => {
    const frag = searchPredicate('50%_x', 1);
    expect(frag!.params).toEqual(['%50\\%\\_x%']);
  });
});

describe('parseDocumentListQuery — kiểm tra tham số + kẹp limit', () => {
  it('mặc định limit=20, offset=0', () => {
    expect(parseDocumentListQuery({})).toEqual({ q: undefined, categoryId: undefined, limit: 20, offset: 0 });
    expect(parseDocumentListQuery(undefined).limit).toBe(20);
  });

  it('limit ngoài [1, 50] được kẹp lại thay vì báo lỗi', () => {
    expect(parseDocumentListQuery({ limit: '0' }).limit).toBe(LIST_LIMIT_MIN);
    expect(parseDocumentListQuery({ limit: '999' }).limit).toBe(LIST_LIMIT_MAX);
    expect(parseDocumentListQuery({ limit: '7' }).limit).toBe(7);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(51)).toBe(50);
    expect(clampLimit(20)).toBe(20);
  });

  it('limit/offset không phải số nguyên không âm -> 400', () => {
    for (const bad of [{ limit: 'abc' }, { limit: '-1' }, { limit: '1.5' }, { offset: '-5' }, { offset: 'x' }]) {
      expect(() => parseDocumentListQuery(bad), JSON.stringify(bad)).toThrowError(
        expect.objectContaining({ statusCode: 400, code: 'INVALID_QUERY' })
      );
    }
    expect(parseDocumentListQuery({ offset: '10' }).offset).toBe(10);
  });

  it('q quá 200 ký tự -> 400; category_id không phải UUID -> 400', () => {
    expect(() => parseDocumentListQuery({ q: 'x'.repeat(201) })).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    expect(parseDocumentListQuery({ q: 'x'.repeat(200) }).q).toHaveLength(200);
    expect(() => parseDocumentListQuery({ category_id: 'khong-phai-uuid' })).toThrowError(
      expect.objectContaining({ statusCode: 400 })
    );
    const uuid = '33333333-3333-4333-8333-333333333333';
    expect(parseDocumentListQuery({ category_id: uuid }).categoryId).toBe(uuid);
  });
});

/** Pool giả luôn ném lỗi — mô phỏng PostgreSQL không khả dụng (sandbox không có DB). */
function brokenPool(): pg.Pool {
  return {
    query: async () => {
      throw new Error('connect ECONNREFUSED (stub)');
    }
  } as unknown as pg.Pool;
}

async function buildTestApp() {
  return createApp({
    pool: brokenPool(),
    config: { ...loadConfig(), logLevel: 'silent' }
  });
}

describe('GET /api/documents — route (không cần PostgreSQL thật)', () => {
  it('query không hợp lệ -> 400 INVALID_QUERY trước khi chạm DB', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/documents?limit=abc' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_QUERY');

      const res2 = await app.inject({ method: 'GET', url: `/api/documents?q=${'x'.repeat(201)}` });
      expect(res2.statusCode).toBe(400);
      expect(res2.json().error.code).toBe('INVALID_QUERY');
    } finally {
      await app.close();
    }
  });

  it('query hợp lệ nhưng DB không khả dụng -> 500 INTERNAL_ERROR (đúng kỳ vọng khi thiếu PostgreSQL)', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/documents' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL_ERROR');

      const resCat = await app.inject({ method: 'GET', url: '/api/categories' });
      expect(resCat.statusCode).toBe(500);
      expect(resCat.json().error.code).toBe('INTERNAL_ERROR');
    } finally {
      await app.close();
    }
  });

  it(
    'rate limit 120/phút theo IP: request thứ 121 -> 429 RATE_LIMITED',
    async () => {
      const app = await buildTestApp();
      try {
        let lastStatus = 0;
        let lastBody: { error?: { code?: string } } = {};
        for (let i = 0; i < 121; i++) {
          const res = await app.inject({ method: 'GET', url: '/api/documents' });
          lastStatus = res.statusCode;
          lastBody = res.json() as typeof lastBody;
        }
        expect(lastStatus).toBe(429);
        expect(lastBody.error?.code).toBe('RATE_LIMITED');
      } finally {
        await app.close();
      }
    },
    30000
  );
});
