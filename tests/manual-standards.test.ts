import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { CurrentUser, UserRole } from '../src/auth/session.js';
import {
  upsertStandardFromDetail,
  upsertStandardFromSearchItem
} from '../src/standards/repository.js';

/**
 * Manual standard metadata (PUT/GET /api/admin/standards/:code):
 * admin-only bằng phiên đăng nhập, upsert theo khóa chuẩn hóa nhẹ với
 * khớp hai khóa code_key_raw, quan hệ replaces một chiều, audit log,
 * và bản ghi manual không bị ingest từ 3 nguồn ghi đè/hạ cấp.
 * Chạy trên FakePool (không cần PostgreSQL thật).
 */

const ADMIN_ID = 'b1111111-1111-4111-8111-111111111111';
const EDITOR_ID = 'b2222222-2222-4222-8222-222222222222';
const VIEWER_ID = 'b3333333-3333-4333-8333-333333333333';
const DISABLED_ADMIN_ID = 'b4444444-4444-4444-8444-444444444444';

function makeUser(
  role: UserRole,
  id: string,
  status: CurrentUser['status'] = 'active'
): CurrentUser {
  return {
    id,
    username: null,
    email: `${id.slice(0, 4)}@congty.vn`,
    role,
    displayName: null,
    userType: 'internal',
    status,
    mustChangePassword: false
  };
}

const admin = makeUser('admin', ADMIN_ID);
const editor = makeUser('editor', EDITOR_ID);
const viewer = makeUser('viewer', VIEWER_ID);
const disabledAdmin = makeUser('admin', DISABLED_ADMIN_ID, 'disabled');

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

type Row = Record<string, unknown>;

class FakePool {
  tokens = new Map<string, CurrentUser>();
  standards = new Map<string, Row>(); // keyed by normalized_code
  relations: unknown[][] = []; // [from_id, type, to_id, to_code_raw, to_norm, to_base_key, source]
  sourcesByStd = new Map<string, string[]>();
  private seq = 0;

  addUser(user: CurrentUser): string {
    const raw = `token-${user.id}`;
    this.tokens.set(hashToken(raw), user);
    return raw;
  }

  reset(): void {
    this.standards.clear();
    this.relations = [];
    this.sourcesByStd.clear();
  }

  private byId(id: unknown): Row | undefined {
    return [...this.standards.values()].find((r) => r.id === id);
  }

  private makeRow(p: unknown[], stub: boolean): Row {
    this.seq += 1;
    const now = new Date('2026-11-26T00:00:00Z');
    if (stub) {
      return {
        id: `id-${this.seq}`,
        org: p[0], number: p[1], part: p[2], year: p[3], amendment: p[4],
        suffix: p[5], normalized_code: p[6], base_key: p[7],
        code_key_raw: p[8], code_display: p[9],
        title_vi: null, title_en: null, status: 'Unknown', issued_date: null,
        effective_date: null, ics: null, detail_level: 'stub',
        parse_confidence: String(p[10]), is_amendment: p[11],
        amendment_year: p[12], is_draft: p[13], needs_review: p[14],
        last_verified_at: null, created_at: now, updated_at: now
      };
    }
    return {
      id: `id-${this.seq}`,
      org: p[0], number: p[1], part: p[2], year: p[3], amendment: p[4],
      suffix: p[5], normalized_code: p[6], base_key: p[7],
      code_key_raw: p[8], code_display: p[9],
      title_vi: p[10], title_en: p[11], status: p[12], issued_date: p[13],
      effective_date: p[14], ics: p[15], detail_level: p[16],
      parse_confidence: String(p[17]), is_amendment: p[18],
      amendment_year: p[19], is_draft: p[20], needs_review: p[21],
      last_verified_at: p[22], created_at: now, updated_at: now
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (s.includes('FROM sessions')) {
      const user = this.tokens.get(String(params[0]));
      return {
        rows: user
          ? [
              {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                display_name: user.displayName,
                status: user.status,
                user_type: user.userType,
                must_change_password: user.mustChangePassword
              }
            ]
          : []
      };
    }

    // findStandardByCode: dual-key with ANY($1) candidates
    if (s.includes('FROM standards') && s.includes('ANY($1)')) {
      const candidates = params[0] as string[];
      const primary = String(params[1]);
      const all = [...this.standards.values()];
      const found =
        all.find((r) => r.normalized_code === primary) ??
        all.find((r) => candidates.includes(String(r.normalized_code))) ??
        all.find((r) => candidates.includes(String(r.code_key_raw)));
      return { rows: found ? [{ ...found }] : [] };
    }

    // upsertStandardRow existing lookup
    if (s.startsWith('SELECT * FROM standards WHERE normalized_code = $1 FOR UPDATE')) {
      const row = this.standards.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [] };
    }

    // resolveCode dual match
    if (s.startsWith('SELECT id FROM standards WHERE normalized_code')) {
      const row = [...this.standards.values()].find(
        (r) => r.normalized_code === params[0] || r.code_key_raw === params[0]
      );
      return { rows: row ? [{ id: row.id }] : [] };
    }

    if (s.startsWith('SELECT normalized_code, base_key FROM standards WHERE id')) {
      const row = this.byId(params[0]);
      return {
        rows: row ? [{ normalized_code: row.normalized_code, base_key: row.base_key }] : []
      };
    }

    if (s.startsWith('SELECT source FROM standard_sources')) {
      const sources = this.sourcesByStd.get(String(params[0])) ?? [];
      return { rows: sources.map((source) => ({ source })) };
    }

    if (s.startsWith('INSERT INTO standards')) {
      const stub = s.includes("'stub'");
      const existing = this.standards.get(String(params[6]));
      if (existing) {
        if (stub) return { rows: [{ id: existing.id }] };
        if (s.includes('DO NOTHING')) return { rows: [] };
        return { rows: [{ ...existing }] };
      }
      const row = this.makeRow(params, stub);
      this.standards.set(String(row.normalized_code), row);
      return { rows: stub ? [{ id: row.id }] : [{ ...row }] };
    }

    if (s.startsWith('UPDATE standards SET last_verified_at')) {
      const row = this.byId(params[0]);
      if (row) row.last_verified_at = new Date();
      return { rows: row ? [{ ...row }] : [] };
    }

    if (s.startsWith('UPDATE standards SET')) {
      const row = this.byId(params[0]);
      if (!row) return { rows: [] };
      const keys = [
        'org', 'number', 'part', 'year', 'amendment', 'suffix', 'code_key_raw',
        'code_display', 'title_vi', 'title_en', 'status', 'issued_date',
        'effective_date', 'ics', 'detail_level', 'parse_confidence',
        'is_amendment', 'amendment_year', 'is_draft', 'needs_review'
      ];
      keys.forEach((k, i) => {
        row[k] = k === 'parse_confidence' ? String(params[i + 1]) : params[i + 1];
      });
      if (params[21] === true) row.last_verified_at = new Date();
      row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }

    if (s.startsWith('INSERT INTO standard_sources')) {
      const stdId = String(params[0]);
      const list = this.sourcesByStd.get(stdId) ?? [];
      if (!list.includes(String(params[1]))) list.push(String(params[1]));
      this.sourcesByStd.set(stdId, list);
      return { rows: [] };
    }

    if (s.startsWith('INSERT INTO standard_relations')) {
      const key = (r: unknown[]) => `${r[0]}|${r[1]}|${r[4]}`;
      const idx = this.relations.findIndex((r) => key(r) === key(params));
      if (idx >= 0) this.relations[idx] = params;
      else this.relations.push(params);
      return { rows: [] };
    }

    if (s.startsWith('DELETE FROM standard_relations WHERE from_id')) {
      this.relations = this.relations.filter(
        (r) => !(r[0] === params[0] && r[1] === params[1])
      );
      return { rows: [] };
    }

    if (s.startsWith('DELETE FROM standard_relations WHERE to_id')) {
      this.relations = this.relations.filter(
        (r) => !(r[2] === params[0] && r[1] === params[1])
      );
      return { rows: [] };
    }

    if (s.includes('FROM standard_relations r') && s.includes('UNION ALL')) {
      const selfId = params[0];
      const toRow = (r: unknown[], direction: string) => {
        const other = this.byId(direction === 'outgoing' ? r[2] : r[0]);
        return {
          direction,
          type: r[1],
          to_code_raw: r[3],
          to_norm: r[4],
          to_base_key: r[5],
          to_id: r[2],
          from_id: r[0],
          source: r[6],
          other_normalized_code: other?.normalized_code ?? null,
          other_code_display: other?.code_display ?? null
        };
      };
      const rows = [
        ...this.relations.filter((r) => r[0] === selfId).map((r) => toRow(r, 'outgoing')),
        ...this.relations.filter((r) => r[2] === selfId).map((r) => toRow(r, 'incoming'))
      ];
      return { rows };
    }

    throw new Error(`FakePool: SQL không hỗ trợ: ${s.slice(0, 90)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

const enc = encodeURIComponent;

describe('manual standard metadata — /api/admin/standards/:code (FakePool)', () => {
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  const cookies: Record<string, string> = {};
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(String(chunk));
      callback();
    }
  });

  beforeAll(async () => {
    pool = new FakePool();
    for (const [key, user] of Object.entries({ admin, editor, viewer, disabledAdmin })) {
      cookies[key] = `elib_session=${pool.addUser(user)}`;
    }
    app = await createApp({
      pool: pool.asPool(),
      config: { ...loadConfig(), logLevel: 'info' },
      logStream
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    pool.reset();
    logChunks.length = 0;
  });

  const put = (code: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: `/api/admin/standards/${enc(code)}`,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      payload: body as Record<string, unknown>
    });

  const get = (code: string, cookie?: string) =>
    app.inject({
      method: 'GET',
      url: `/api/admin/standards/${enc(code)}`,
      headers: cookie ? { cookie } : {}
    });

  it('phân quyền: anonymous 401, editor/viewer 403, admin disabled 401 (cả GET lẫn PUT)', async () => {
    expect((await put('TCVN 9143:2022', { title_vi: 'x' })).statusCode).toBe(401);
    expect((await get('TCVN 9143:2022')).statusCode).toBe(401);
    expect((await put('TCVN 9143:2022', { title_vi: 'x' }, cookies.editor)).statusCode).toBe(403);
    expect((await get('TCVN 9143:2022', cookies.editor)).statusCode).toBe(403);
    expect((await put('TCVN 9143:2022', { title_vi: 'x' }, cookies.viewer)).statusCode).toBe(403);
    expect((await get('TCVN 9143:2022', cookies.viewer)).statusCode).toBe(403);
    expect((await put('TCVN 9143:2022', { title_vi: 'x' }, cookies.disabledAdmin)).statusCode).toBe(401);
    expect((await get('TCVN 9143:2022', cookies.disabledAdmin)).statusCode).toBe(401);
    expect(pool.standards.size).toBe(0); // không ghi gì khi bị chặn
  });

  it('PUT tạo mới: detail_level=manual, org/number từ parser, year từ code', async () => {
    const res = await put(
      'TCVN 9143:2022',
      {
        title_vi: 'Công trình thủy lợi. Tính toán thấm',
        title_en: 'Hydraulic structures',
        status: 'Active',
        issued_date: '2022-12-21',
        ics: ['93.160']
      },
      cookies.admin
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.standard.normalized_code).toBe('TCVN9143:2022');
    expect(body.standard.code).toBe('TCVN 9143:2022');
    expect(body.standard.detail_level).toBe('manual');
    expect(body.standard.title_vi).toBe('Công trình thủy lợi. Tính toán thấm');
    expect(body.standard.status).toBe('Active');
    expect(body.standard.issued_date).toBe('2022-12-21');
    expect(body.standard.ics).toEqual(['93.160']);
    expect(body.standard.year).toBe(2022);
    expect(body.standard.org).toBe('TCVN');
    expect(body.standard.number).toBe('9143');
    expect(pool.standards.size).toBe(1);
  });

  it('PUT cập nhật bản ghi có sẵn: chỉ trường được gửi thay đổi, detail_level thành manual', async () => {
    await upsertStandardFromSearchItem(
      pool.asPool(),
      { code: 'TCVN 9143:2022', year: 2022, name: 'Tên từ nguồn', status: 'Active' },
      'TCVN_VN'
    );
    expect(pool.standards.get('TCVN9143:2022')?.detail_level).toBe('summary');

    const res = await put(
      'TCVN 9143:2022',
      { title_en: 'English title', status: 'Withdrawn' },
      cookies.admin
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(false);
    expect(body.standard.detail_level).toBe('manual');
    expect(body.standard.title_vi).toBe('Tên từ nguồn'); // không gửi -> giữ nguyên
    expect(body.standard.title_en).toBe('English title');
    expect(body.standard.status).toBe('Withdrawn');
    expect(pool.standards.size).toBe(1);
  });

  it('khớp hai khóa: PUT "14 TCN 58-88" cập nhật bản lưu 14TCN58:1988 qua code_key_raw', async () => {
    await upsertStandardFromSearchItem(
      pool.asPool(),
      { code: '14 TCN 58-88', year: 1988, name: 'Tiêu chuẩn cũ' },
      'TCVN_VN'
    );
    const stored = pool.standards.get('14TCN58:1988');
    expect(stored?.code_key_raw).toBe('14TCN58-88');

    const res = await put('14 TCN 58-88', { title_vi: 'Tên đã sửa tay' }, cookies.admin);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(false);
    expect(body.standard.id).toBe(stored?.id);
    expect(body.standard.normalized_code).toBe('14TCN58:1988');
    expect(body.standard.year).toBe(1988); // năm không bị xóa khi sửa bằng mã không năm
    expect(body.standard.title_vi).toBe('Tên đã sửa tay');
    expect(body.standard.detail_level).toBe('manual');
    expect(pool.standards.size).toBe(1); // không tạo bản trùng

    // GET bằng dạng thô cũng ra đúng bản ghi
    const got = await get('14 TCN 58-88', cookies.admin);
    expect(got.statusCode).toBe(200);
    expect(got.json().standard.normalized_code).toBe('14TCN58:1988');
  });

  it('GET: 404 khi chưa có, 400 khi mã không chuẩn hóa được; PUT mã rác 400 INVALID_STANDARD_CODE', async () => {
    const missing = await get('TCVN 9999:2099', cookies.admin);
    expect(missing.statusCode).toBe(404);

    const badGet = await get('???', cookies.admin);
    expect(badGet.statusCode).toBe(400);
    expect(badGet.json().error.code).toBe('INVALID_STANDARD_CODE');

    const badPut = await put('12345', { title_vi: 'x' }, cookies.admin);
    expect(badPut.statusCode).toBe(400);
    expect(badPut.json().error.code).toBe('INVALID_STANDARD_CODE');

    const prosePut = await put('BS EN 13146-1 đến 10:2019', { title_vi: 'x' }, cookies.admin);
    expect(prosePut.statusCode).toBe(400);
    expect(pool.standards.size).toBe(0);
  });

  it('body không hợp lệ -> 400 INVALID_INPUT (status lạ, ngày sai dạng)', async () => {
    const badStatus = await put('TCVN 9143:2022', { status: 'Ban hành' }, cookies.admin);
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json().error.code).toBe('INVALID_INPUT');

    const badDate = await put('TCVN 9143:2022', { issued_date: '21/12/2022' }, cookies.admin);
    expect(badDate.statusCode).toBe(400);
    expect(pool.standards.size).toBe(0);
  });

  it('không bịa năm: mã không năm + không year field -> year null; có year field -> khóa có năm', async () => {
    const noYear = await put('TCVN 4253', { title_vi: 'Bản không năm' }, cookies.admin);
    expect(noYear.statusCode).toBe(200);
    expect(noYear.json().standard.normalized_code).toBe('TCVN4253');
    expect(noYear.json().standard.year).toBeNull();

    const withYear = await put('ISO 9001', { year: 2015, title_en: 'QMS' }, cookies.admin);
    expect(withYear.statusCode).toBe(200);
    expect(withYear.json().standard.normalized_code).toBe('ISO9001:2015');
    expect(withYear.json().standard.year).toBe(2015);
  });

  it('mã có dấu "/" đi qua path param đã encode (GB/T -> GBT theo luật khóa gộp)', async () => {
    const res = await put('GB/T 19001-2016', { year: 2016, title_en: 'QMS' }, cookies.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().standard.normalized_code).toBe('GBT19001:2016');
    expect(res.json().standard.code).toBe('GB/T 19001-2016');
  });

  it('quan hệ replaces một chiều + stub đích có năm; replaced_by đảo thành replaces', async () => {
    const res = await put(
      'TCVN 9143:2022',
      { status: 'Active', replaces: 'TCVN 9143:2012' },
      cookies.admin
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().standard.replaces).toEqual(['TCVN 9143:2012']);
    expect(res.json().standard.replaced_by).toEqual([]);
    // Stub cho đích có năm, đúng 1 cạnh một chiều 2022 -> 2012
    expect(pool.standards.get('TCVN9143:2012')?.detail_level).toBe('stub');
    expect(pool.relations.length).toBe(1);
    const [fromId, type, toId, , toNorm, , source] = pool.relations[0];
    expect(type).toBe('replaces');
    expect(toNorm).toBe('TCVN9143:2012');
    expect(source).toBe('MANUAL');
    expect(fromId).toBe(pool.standards.get('TCVN9143:2022')?.id);
    expect(toId).toBe(pool.standards.get('TCVN9143:2012')?.id);

    // GET bản 2012: replaced_by suy từ cạnh ngược, không có cạnh riêng nào khác
    const got2012 = await get('TCVN 9143:2012', cookies.admin);
    expect(got2012.json().standard.replaced_by).toEqual(['TCVN 9143:2022']);
    expect(got2012.json().standard.replaces).toEqual([]);

    // Sửa tay bản 2012 với replaced_by dạng mảng -> vẫn chỉ một cạnh một chiều
    const res2 = await put(
      'TCVN 9143:2012',
      { status: 'Withdrawn', replaced_by: ['TCVN 9143:2022'] },
      cookies.admin
    );
    expect(res2.statusCode).toBe(200);
    expect(res2.json().standard.replaced_by).toEqual(['TCVN 9143:2022']);
    expect(res2.json().standard.detail_level).toBe('manual');
    expect(pool.relations.length).toBe(1); // thay thế, không nhân đôi
  });

  it('replaces đích không năm: không stub, cạnh lưu to_norm/to_base_key, to_id NULL', async () => {
    const res = await put(
      'TCVN 9143:2022',
      { replaces: ['TCVN 4253'] },
      cookies.admin
    );
    expect(res.statusCode).toBe(200);
    expect(pool.standards.has('TCVN4253')).toBe(false);
    expect(pool.relations.length).toBe(1);
    const [, type, toId, toRaw, toNorm, toBaseKey] = pool.relations[0];
    expect(type).toBe('replaces');
    expect(toId).toBeNull();
    expect(toRaw).toBe('TCVN 4253');
    expect(toNorm).toBe('TCVN4253');
    expect(toBaseKey).toBe('TCVN4253');
  });

  it('audit log được ghi mỗi lần lưu', async () => {
    const res = await put('TCVN 9143:2022', { title_vi: 'Kiểm tra audit' }, cookies.admin);
    expect(res.statusCode).toBe(200);
    const lines = logChunks
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    const audit = lines.find((l) => l.audit === 'standard_manual_saved');
    expect(audit).toBeDefined();
    expect(audit?.adminId).toBe(ADMIN_ID);
    expect(audit?.normalizedCode).toBe('TCVN9143:2022');
    expect(audit?.created).toBe(true);
  });

  it('CSRF: PUT với Origin lệch host -> 403 (hook /api/* có sẵn)', async () => {
    const res = await put(
      'TCVN 9143:2022',
      { title_vi: 'x' },
      cookies.admin,
      { origin: 'https://evil.example' }
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_ORIGIN_MISMATCH');
    expect(pool.standards.size).toBe(0);
  });

  it('bản ghi manual sống sót qua ingest từ cả 3 nguồn (search + detail)', async () => {
    const created = await put(
      'TCVN 9143:2022',
      {
        title_vi: 'Tên do admin nhập',
        title_en: 'Admin title',
        status: 'Active',
        issued_date: '2022-12-21',
        ics: ['93.160']
      },
      cookies.admin
    );
    expect(created.statusCode).toBe(200);

    const sources = ['VSQI', 'TCVN_VN', 'TCVN_QT'] as const;
    for (const source of sources) {
      await upsertStandardFromSearchItem(
        pool.asPool(),
        {
          code: 'TCVN 9143:2022',
          year: 2022,
          name: `Tên nguồn ${source}`,
          englishName: `Source title ${source}`,
          status: 'Withdrawn',
          ics: ['00.000']
        },
        source
      );
      await upsertStandardFromDetail(
        pool.asPool(),
        {
          code: 'TCVN 9143:2022',
          year: 2022,
          name: `Detail ${source}`,
          englishName: `Detail EN ${source}`,
          status: 'Withdrawn',
          issuedDate: '1999-01-01',
          effectiveDate: '1999-06-01',
          ics: ['11.111'],
          replaces: 'TCVN 9143:2012'
        },
        source
      );
    }

    const row = pool.standards.get('TCVN9143:2022');
    expect(row?.detail_level).toBe('manual'); // không bị hạ cấp
    expect(row?.title_vi).toBe('Tên do admin nhập');
    expect(row?.title_en).toBe('Admin title');
    expect(row?.status).toBe('Active');
    expect(row?.issued_date).toBe('2022-12-21');
    expect(row?.effective_date).toBeNull();
    expect(row?.ics).toEqual(['93.160']);

    // GET qua API cũng thấy nguyên giá trị manual
    const got = await get('TCVN 9143:2022', cookies.admin);
    expect(got.json().standard.title_vi).toBe('Tên do admin nhập');
    expect(got.json().standard.detail_level).toBe('manual');
  });

  it('xóa trường bằng null/rỗng: title_vi null -> NULL, ics [] -> NULL, trường vắng mặt giữ nguyên', async () => {
    await put(
      'TCVN 9143:2022',
      { title_vi: 'Tên gốc', title_en: 'Original', ics: ['93.160'] },
      cookies.admin
    );
    const res = await put('TCVN 9143:2022', { title_vi: null, ics: [] }, cookies.admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().standard.title_vi).toBeNull();
    expect(res.json().standard.ics).toBeNull();
    expect(res.json().standard.title_en).toBe('Original');
  });
});
