import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import {
  normalizeStatus,
  splitReplacesString,
  mergeStandardFields,
  relationEdgesFromDetail,
  upsertStandardFromDetail,
  upsertStandardFromSearchItem,
  lookupByCode,
  type StandardRow
} from '../src/standards/repository.js';
import { tokenMatches } from '../src/routes/internal-standards.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

// Unit tests for merge/relation logic run without a DB. DB tests are gated
// behind ELIB_RUN_DB_TESTS=1 + DATABASE_URL (sandbox has no PostgreSQL) —
// they are SKIPPED, not faked. Live-Postgres verification on a copy of the
// real elib DB is required before PR-A merges (user rule 2026-11-23).
const hasDb = !!process.env.DATABASE_URL && process.env.ELIB_RUN_DB_TESTS === '1';

describe('normalizeStatus', () => {
  it('map các dạng trạng thái đã biết, còn lại Unknown', () => {
    expect(normalizeStatus('Active')).toBe('Active');
    expect(normalizeStatus('Còn hiệu lực')).toBe('Active');
    expect(normalizeStatus('Withdrawn')).toBe('Withdrawn');
    expect(normalizeStatus('Hết hiệu lực')).toBe('Withdrawn');
    expect(normalizeStatus('')).toBe('Unknown');
    expect(normalizeStatus(null)).toBe('Unknown');
    expect(normalizeStatus('something else')).toBe('Unknown');
  });
});

describe('splitReplacesString', () => {
  it('tách chuỗi replaces gộp bằng * và bỏ ngày trong ngoặc (mẫu ISO 9001 thật)', () => {
    const raw =
      'ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)';
    expect(splitReplacesString(raw)).toEqual([
      'ISO 9001',
      'ISO/FDIS 9001',
      'ISO 9001 Technical Corrigendum 1'
    ]);
  });

  it('mã đơn và chuỗi rỗng', () => {
    expect(splitReplacesString('TCVN 9143:2012')).toEqual(['TCVN 9143:2012']);
    expect(splitReplacesString('')).toEqual([]);
    expect(splitReplacesString(null)).toEqual([]);
  });
});

function makeRow(overrides: Partial<StandardRow> = {}): StandardRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    org: 'TCVN',
    number: '9143',
    part: null,
    year: 2022,
    amendment: null,
    suffix: null,
    normalized_code: 'TCVN9143:2022',
    base_key: 'TCVN9143',
    code_display: 'TCVN 9143:2022',
    title_vi: 'Tên tiếng Việt',
    title_en: null,
    status: 'Active',
    issued_date: '2022-12-21',
    effective_date: null,
    ics: ['93.160'],
    detail_level: 'full',
    parse_confidence: '0.9',
    is_amendment: false,
    needs_review: false,
    last_verified_at: new Date('2026-11-01T00:00:00Z'),
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_at: new Date('2026-11-01T00:00:00Z'),
    ...overrides
  };
}

describe('mergeStandardFields — quy tắc gộp 4.3', () => {
  const incomingBase = {
    org: 'TCVN',
    number: '9143',
    part: null,
    year: 2022,
    amendment: null,
    suffix: null,
    normalized_code: 'TCVN9143:2022',
    base_key: 'TCVN9143',
    code_display: 'TCVN 9143:2022',
    title_vi: null,
    title_en: 'English title',
    status: 'Unknown' as const,
    issued_date: null,
    effective_date: null,
    ics: null,
    detail_level: 'summary' as const,
    parse_confidence: 0.8,
    is_amendment: false,
    needs_review: false
  };

  it('summary không ghi đè trường đã có từ full, chỉ lấp chỗ trống', () => {
    const merged = mergeStandardFields(makeRow(), incomingBase, 'TCVN_VN', ['TCVN_VN']);
    expect(merged.title_vi).toBe('Tên tiếng Việt');
    expect(merged.title_en).toBe('English title');
    expect(merged.issued_date).toBe('2022-12-21');
    expect(merged.detail_level).toBe('full');
  });

  it('không bao giờ ghi đè giá trị có bằng giá trị rỗng', () => {
    const merged = mergeStandardFields(
      makeRow({ detail_level: 'summary' }),
      { ...incomingBase, detail_level: 'full', title_vi: '', issued_date: '  ' },
      'TCVN_VN',
      []
    );
    expect(merged.title_vi).toBe('Tên tiếng Việt');
    expect(merged.issued_date).toBe('2022-12-21');
    expect(merged.detail_level).toBe('full');
  });

  it('bản ghi manual không bị ingest ghi đè', () => {
    const manual = makeRow({ detail_level: 'manual' });
    const merged = mergeStandardFields(
      manual,
      { ...incomingBase, detail_level: 'full', title_vi: 'Tên khác', status: 'Withdrawn' },
      'TCVN_VN',
      []
    );
    expect(merged.title_vi).toBe('Tên tiếng Việt');
    expect(merged.status).toBe('Active');
    expect(merged.detail_level).toBe('manual');
  });

  it('status ưu tiên TCVN: VSQI không thay status đã có từ TCVN; Unknown không thay status đã biết', () => {
    const fromVsqi = mergeStandardFields(
      makeRow({ detail_level: 'summary' }),
      { ...incomingBase, status: 'Withdrawn' },
      'VSQI',
      ['TCVN_VN']
    );
    expect(fromVsqi.status).toBe('Active');
    const unknownIncoming = mergeStandardFields(
      makeRow({ detail_level: 'summary' }),
      { ...incomingBase, status: 'Unknown' },
      'TCVN_VN',
      []
    );
    expect(unknownIncoming.status).toBe('Active');
  });
});

describe('relationEdgesFromDetail — một chiều, replacedBy đảo thành replaces', () => {
  it('TCVN 9143:2012 replacedBy 2022 → cạnh 2022 replaces 2012 (SELF)', () => {
    const edges = relationEdgesFromDetail({
      code: 'TCVN 9143:2012',
      replacedBy: 'TCVN 9143:2022'
    });
    expect(edges).toEqual([
      {
        fromCodeRaw: 'TCVN 9143:2022',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: 'SELF',
        toYear: null,
        toRawOnly: false
      }
    ]);
  });

  it('replaces chuỗi * của TCVN_QT tách thành từng cạnh, năm từ "(YYYY-MM)", corrigendum rawOnly', () => {
    const edges = relationEdgesFromDetail({
      code: 'ISO 9001',
      replaces:
        'ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)'
    });
    expect(edges).toEqual([
      {
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: 'ISO 9001',
        toYear: 2008,
        toRawOnly: false
      },
      {
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: 'ISO/FDIS 9001',
        toYear: 2015,
        toRawOnly: false
      },
      {
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: 'ISO 9001 Technical Corrigendum 1 (2009-07)',
        toYear: 2009,
        toRawOnly: true
      }
    ]);
  });

  it('relations[]: replacedBy đảo chiều, ics bị bỏ qua, equivalent giữ nguyên', () => {
    const edges = relationEdgesFromDetail({
      code: 'TCVN 9143:2022',
      relations: [
        { type: 'replaces', code: 'TCVN 9143:2012' },
        { type: 'ics', text: '93.160' },
        { type: 'equivalent', code: 'ISO 3010:2001' }
      ]
    });
    expect(edges).toEqual([
      {
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: 'TCVN 9143:2012',
        toYear: null,
        toRawOnly: false
      },
      {
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'equivalent',
        toCodeRaw: 'ISO 3010:2001',
        toYear: null,
        toRawOnly: false
      }
    ]);
  });
});

describe('tokenMatches — so sánh hằng thời gian', () => {
  it('đúng/sai/thiếu', () => {
    expect(tokenMatches('secret-123', 'secret-123')).toBe(true);
    expect(tokenMatches('secret-124', 'secret-123')).toBe(false);
    expect(tokenMatches('short', 'secret-123')).toBe(false);
    expect(tokenMatches('', 'secret-123')).toBe(false);
    expect(tokenMatches(undefined, 'secret-123')).toBe(false);
  });
});

/** Pool giả luôn ném lỗi — mô phỏng PostgreSQL không khả dụng. */
function brokenPool(): pg.Pool {
  return {
    query: async () => {
      throw new Error('connect ECONNREFUSED (stub)');
    },
    connect: async () => {
      throw new Error('connect ECONNREFUSED (stub)');
    }
  } as unknown as pg.Pool;
}

describe('/internal/standards — guard token (không cần PostgreSQL thật)', () => {
  it('thiếu STANDARDS_INTERNAL_TOKEN -> 503 STANDARDS_DISABLED', async () => {
    const app = await createApp({
      pool: brokenPool(),
      config: { ...loadConfig(), logLevel: 'silent', standardsInternalToken: null }
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/standards/ingest',
        payload: { kind: 'search', source: 'TCVN_VN', items: [] }
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('STANDARDS_DISABLED');
    } finally {
      await app.close();
    }
  });

  it('token sai/thiếu -> 401, token đúng nhưng DB lỗi -> 500 (không lộ token trong response)', async () => {
    const app = await createApp({
      pool: brokenPool(),
      config: { ...loadConfig(), logLevel: 'silent', standardsInternalToken: 'test-token' }
    });
    try {
      const noToken = await app.inject({
        method: 'GET',
        url: '/internal/standards/lookup?q=TCVN%209143'
      });
      expect(noToken.statusCode).toBe(401);

      const wrong = await app.inject({
        method: 'GET',
        url: '/internal/standards/lookup?q=TCVN%209143',
        headers: { 'x-internal-token': 'wrong-token' }
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).not.toContain('wrong-token');
      expect(wrong.body).not.toContain('test-token');

      const right = await app.inject({
        method: 'GET',
        url: '/internal/standards/lookup?q=TCVN%209143',
        headers: { 'x-internal-token': 'test-token' }
      });
      expect(right.statusCode).toBe(500); // DB stub lỗi — guard đã qua
      expect(right.body).not.toContain('test-token');
    } finally {
      await app.close();
    }
  });

  it('body không hợp lệ -> 400 trước khi chạm DB; trường raw bị bỏ qua', async () => {
    const app = await createApp({
      pool: brokenPool(),
      config: { ...loadConfig(), logLevel: 'silent', standardsInternalToken: 'test-token' }
    });
    try {
      const bad = await app.inject({
        method: 'POST',
        url: '/internal/standards/ingest',
        headers: { 'x-internal-token': 'test-token' },
        payload: { kind: 'search', source: 'TCVN_VN' } // thiếu items
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/** Pool giả ghi lại mọi query — kiểm tra luồng ingest không cần PostgreSQL. */
class FakeDb {
  standards = new Map<string, Record<string, unknown>>();
  relations: unknown[][] = [];
  private seq = 0;

  private makeRow(p: unknown[], stub: boolean): Record<string, unknown> {
    this.seq += 1;
    const now = new Date('2026-11-23T00:00:00Z');
    if (stub) {
      return {
        id: `id-${this.seq}`,
        org: p[0], number: p[1], part: p[2], year: p[3], amendment: p[4],
        suffix: p[5], normalized_code: p[6], base_key: p[7], code_display: p[8],
        title_vi: null, title_en: null, status: 'Unknown', issued_date: null,
        effective_date: null, ics: null, detail_level: 'stub',
        parse_confidence: String(p[9]), is_amendment: p[10], needs_review: p[11],
        last_verified_at: null, created_at: now, updated_at: now
      };
    }
    return {
      id: `id-${this.seq}`,
      org: p[0], number: p[1], part: p[2], year: p[3], amendment: p[4],
      suffix: p[5], normalized_code: p[6], base_key: p[7], code_display: p[8],
      title_vi: p[9], title_en: p[10], status: p[11], issued_date: p[12],
      effective_date: p[13], ics: p[14], detail_level: p[15],
      parse_confidence: String(p[16]), is_amendment: p[17], needs_review: p[18],
      last_verified_at: p[19], created_at: now, updated_at: now
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
    if (s.startsWith('SELECT * FROM standards WHERE normalized_code')) {
      const row = this.standards.get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (s.startsWith('SELECT id FROM standards WHERE normalized_code')) {
      const row = this.standards.get(String(params[0]));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (s.startsWith('SELECT normalized_code, base_key FROM standards WHERE id')) {
      const row = [...this.standards.values()].find((r) => r.id === params[0]);
      return {
        rows: row ? [{ normalized_code: row.normalized_code, base_key: row.base_key }] : []
      };
    }
    if (s.startsWith('SELECT source FROM standard_sources')) return { rows: [] };
    if (s.startsWith('INSERT INTO standards')) {
      const stub = s.includes("'stub'");
      const existing = this.standards.get(String(params[6]));
      if (existing) return { rows: stub ? [{ id: existing.id }] : [existing] };
      const row = this.makeRow(params, stub);
      this.standards.set(String(row.normalized_code), row);
      return { rows: stub ? [{ id: row.id }] : [row] };
    }
    if (s.startsWith('UPDATE standards SET last_verified_at')) {
      const row = [...this.standards.values()].find((r) => r.id === params[0]);
      return { rows: row ? [row] : [] };
    }
    if (s.startsWith('UPDATE standards SET')) {
      const row = [...this.standards.values()].find((r) => r.id === params[0]);
      if (!row) return { rows: [] };
      const keys = [
        'org', 'number', 'part', 'year', 'amendment', 'suffix', 'code_display',
        'title_vi', 'title_en', 'status', 'issued_date', 'effective_date', 'ics',
        'detail_level', 'parse_confidence', 'is_amendment', 'needs_review'
      ];
      keys.forEach((k, i) => {
        row[k] = k === 'parse_confidence' ? String(params[i + 1]) : params[i + 1];
      });
      return { rows: [row] };
    }
    if (s.startsWith('INSERT INTO standard_sources')) return { rows: [] };
    if (s.startsWith('INSERT INTO standard_relations')) {
      this.relations.push(params);
      return { rows: [] };
    }
    throw new Error(`FakeDb: SQL không hỗ trợ: ${s.slice(0, 80)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

describe('ingest với khóa chuẩn hóa nhẹ (FakeDb, không cần PostgreSQL)', () => {
  it('mã rác bị bỏ qua + log, không hỏng lô; mã tốt vẫn lưu', async () => {
    const db = new FakeDb();
    const logs: string[] = [];
    const bad = await upsertStandardFromSearchItem(
      db.asPool(),
      { code: '???' },
      'TCVN_VN',
      (m) => logs.push(m)
    );
    expect(bad).toEqual([]);
    expect(logs.length).toBe(1);
    expect(db.standards.size).toBe(0);

    const good = await upsertStandardFromSearchItem(
      db.asPool(),
      { code: 'ISO 9001', year: 2015, name: 'Quality management systems' },
      'TCVN_QT'
    );
    expect(good.length).toBe(1);
    // QT code không năm + year field -> khóa có năm, gộp được với nguồn viết kèm năm
    expect(db.standards.has('ISO9001:2015')).toBe(true);
  });

  it('đích quan hệ không năm (TCVN 4253): không tạo stub, lưu to_norm + to_base_key, to_id NULL', async () => {
    const db = new FakeDb();
    await upsertStandardFromDetail(
      db.asPool(),
      {
        code: 'TCVN 9143:2022',
        year: 2022,
        status: 'Active',
        relations: [{ type: 'normativeReference', code: 'TCVN 4253' }]
      },
      'VSQI'
    );
    expect(db.standards.has('TCVN4253')).toBe(false); // không stub khóa giả
    expect(db.relations.length).toBe(1);
    const [, type, toId, toRaw, toNorm, toBaseKey] = db.relations[0];
    expect(type).toBe('normativeReference');
    expect(toId).toBeNull();
    expect(toRaw).toBe('TCVN 4253');
    expect(toNorm).toBe('TCVN4253');
    expect(toBaseKey).toBe('TCVN4253');
  });

  it('replaces QT: ISO9001:2008 + ISOFDIS9001:2015 có stub, corrigendum raw to_id NULL', async () => {
    const db = new FakeDb();
    await upsertStandardFromDetail(
      db.asPool(),
      {
        code: 'ISO 9001',
        year: 2015,
        status: 'Active',
        replaces:
          'ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)'
      },
      'TCVN_QT'
    );
    expect(db.standards.has('ISO9001:2015')).toBe(true);
    expect(db.standards.has('ISO9001:2008')).toBe(true); // stub cho đích có năm
    expect(db.standards.has('ISOFDIS9001:2015')).toBe(true); // designation riêng
    const byNorm = new Map(db.relations.map((r) => [String(r[4]), r]));
    expect(byNorm.get('ISO9001:2008')?.[2]).not.toBeNull();
    expect(byNorm.get('ISOFDIS9001:2015')?.[2]).not.toBeNull();
    const corr = db.relations.find((r) => String(r[3]).includes('Technical Corrigendum'));
    expect(corr).toBeDefined();
    expect(corr?.[2]).toBeNull(); // to_id NULL — không parse văn xuôi
  });

  it('bản không năm không bị ghi đè khi sau này có bản có năm', async () => {
    const db = new FakeDb();
    await upsertStandardFromSearchItem(
      db.asPool(),
      { code: 'TCVN 4253', name: 'Bản không năm' },
      'VSQI'
    );
    await upsertStandardFromSearchItem(
      db.asPool(),
      { code: 'TCVN 4253:2020', year: 2020, name: 'Bản 2020' },
      'TCVN_VN'
    );
    expect(db.standards.size).toBe(2);
    expect(db.standards.get('TCVN4253')?.title_vi).toBe('Bản không năm');
    expect(db.standards.get('TCVN4253:2020')?.title_vi).toBe('Bản 2020');
  });
});

describe.skipIf(!hasDb)('standards repository (cần PostgreSQL thật)', () => {
  const pool = hasDb ? createPool(process.env.DATABASE_URL as string) : (null as never);

  it('migration 003 chạy được và chạy lại an toàn; CHECK chặn documents có standard_id + price', async () => {
    const sql003 = readFileSync(
      new URL('../migrations/003_standards.sql', import.meta.url),
      'utf8'
    );
    await pool.query(sql003);
    await pool.query(sql003); // idempotent

    const std = await pool.query<{ id: string }>(
      `INSERT INTO standards (org, number, normalized_code, base_key, code_display)
       VALUES ('TCVN','99999','TCVN99999:2099','TCVN99999','TCVN 99999:2099')
       ON CONFLICT (normalized_code) DO UPDATE SET code_display = EXCLUDED.code_display
       RETURNING id`
    );
    const stdId = std.rows[0].id;
    await expect(
      pool.query(
        `INSERT INTO documents (title, slug, price, standard_id)
         VALUES ('Tài liệu test CHECK', 'test-check-003', 1000, $1)`,
        [stdId]
      )
    ).rejects.toThrow(/std_docs_not_for_sale/);
    // price NULL thì được phép
    await pool.query(
      `INSERT INTO documents (title, slug, standard_id)
       VALUES ('Tài liệu test CHECK ok', 'test-check-003-ok', $1)
       ON CONFLICT (slug) DO NOTHING`,
      [stdId]
    );
    await pool.query("DELETE FROM documents WHERE slug IN ('test-check-003','test-check-003-ok')");
    await pool.query('DELETE FROM standards WHERE id = $1', [stdId]);
  });

  it('upsert detail idempotent + quan hệ một chiều + stub + lookup bản mới nhất', async () => {
    const detail2022 = {
      code: 'TCVN 9143:2022',
      name: 'Công trình thủy lợi. Tính toán thấm',
      englishName: 'Hydraulic structures',
      year: 2022,
      status: 'Active',
      issuedDate: '2022-12-21',
      replaces: 'TCVN 9143:2012',
      detailUrl: 'http://example.invalid/vs-standard/x'
    };
    const ids1 = await upsertStandardFromDetail(pool, detail2022, 'TCVN_VN');
    const ids2 = await upsertStandardFromDetail(pool, detail2022, 'TCVN_VN');
    expect(ids1).toEqual(ids2);
    const count = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM standards WHERE normalized_code = 'TCVN9143:2022'"
    );
    expect(Number(count.rows[0].n)).toBe(1);

    // Stub cho 2012 được tạo, cạnh replaces chỉ một chiều 2022 -> 2012
    const rel = await pool.query<{ from_code: string; to_code: string; type: string }>(
      `SELECT f.normalized_code AS from_code, t.normalized_code AS to_code, r.type
         FROM standard_relations r
         JOIN standards f ON f.id = r.from_id
         LEFT JOIN standards t ON t.id = r.to_id
        WHERE f.normalized_code = 'TCVN9143:2022' AND r.type = 'replaces'`
    );
    expect(rel.rows).toEqual([
      { from_code: 'TCVN9143:2022', to_code: 'TCVN9143:2012', type: 'replaces' }
    ]);
    const stub = await pool.query<{ detail_level: string }>(
      "SELECT detail_level FROM standards WHERE normalized_code = 'TCVN9143:2012'"
    );
    expect(stub.rows[0].detail_level).toBe('stub');

    // Tra không năm -> bản 2022 (mới nhất); tra có năm -> đúng bản
    const byBase = await lookupByCode(pool, 'tcvn 9143');
    expect(byBase?.standard.normalized_code).toBe('TCVN9143:2022');
    const byYear = await lookupByCode(pool, 'TCVN9143:2012');
    expect(byYear?.standard.normalized_code).toBe('TCVN9143:2012');
    expect(byYear?.relations.some((r) => r.direction === 'incoming' && r.type === 'replaces')).toBe(true);

    // Search item không hạ cấp bản full
    await upsertStandardFromSearchItem(
      pool,
      { code: 'TCVN 9143:2022', name: '', status: 'Withdrawn' },
      'VSQI'
    );
    const after = await lookupByCode(pool, 'TCVN 9143:2022');
    expect(after?.standard.detail_level).toBe('full');
    expect(after?.standard.status).toBe('Active');

    await pool.query(
      "DELETE FROM standards WHERE normalized_code IN ('TCVN9143:2022','TCVN9143:2012')"
    );
  });

  it('lookup không năm: mọi ấn bản, mới nhất đầu, amendment/FDIS xếp dưới bản chính; đích không năm không stub', async () => {
    await upsertStandardFromDetail(
      pool,
      {
        code: 'ISO 9001',
        year: 2015,
        name: 'Quality management systems',
        status: 'Active',
        replaces:
          'ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)',
        relations: [{ type: 'normativeReference', code: 'TCVN 4253' }]
      },
      'TCVN_QT'
    );
    await upsertStandardFromSearchItem(
      pool,
      { code: 'ISO 9001:2015/Amd 1:2016', year: 2015, status: 'Active' },
      'TCVN_QT'
    );

    // Đích không năm: không có stub TCVN4253, cạnh lưu to_base_key
    const stub4253 = await pool.query(
      "SELECT 1 FROM standards WHERE normalized_code = 'TCVN4253'"
    );
    expect(stub4253.rows.length).toBe(0);
    const rel4253 = await pool.query<{ to_id: string | null; to_base_key: string }>(
      "SELECT to_id, to_base_key FROM standard_relations WHERE to_norm = 'TCVN4253'"
    );
    expect(rel4253.rows[0].to_id).toBeNull();
    expect(rel4253.rows[0].to_base_key).toBe('TCVN4253');

    // Tìm không năm -> base_key ISO9001: bản chính 2015 đầu, rồi 2008,
    // amendment xếp dưới bản chính cùng base_key
    const found = await lookupByCode(pool, 'iso 9001');
    expect(found?.standard.normalized_code).toBe('ISO9001:2015');
    const codes = found?.editions.map((e) => e.normalized_code) ?? [];
    expect(codes[0]).toBe('ISO9001:2015');
    expect(codes).toContain('ISO9001:2008');
    expect(codes).toContain('ISO9001:2015/AMD1:2016');
    expect(codes.indexOf('ISO9001:2015/AMD1:2016')).toBeGreaterThan(
      codes.indexOf('ISO9001:2015')
    );
    // FDIS là designation riêng (base_key khác) — tra riêng ra đúng bản FDIS
    const fdis = await lookupByCode(pool, 'ISO/FDIS 9001:2015');
    expect(fdis?.standard.normalized_code).toBe('ISOFDIS9001:2015');

    await pool.query(
      "DELETE FROM standards WHERE normalized_code IN ('ISO9001:2015','ISO9001:2008','ISOFDIS9001:2015','ISO9001:2015/AMD1:2016')"
    );
  });
});
