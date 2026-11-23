// Standards metadata repository (Bước 1, Phase 2).
//
// Owns all SQL for standards / standard_sources / standard_relations /
// search_log. Data is fed gradually from real search/detail requests via
// the internal API — never bulk-crawled. Merge rules (spec 4.3):
// - one standard = one row per normalized_code, one snapshot per source;
// - never overwrite a non-empty field with an empty one;
// - summary never overwrites fields set by full; manual records are never
//   overwritten by ingest (only last_verified_at is touched — manual rows
//   are human-curated, so ingest must not fight the curator);
// - status prefers TCVN sources over VSQI;
// - replacement relations are stored in ONE direction only: "A replacedBy
//   B" becomes "B replaces A"; the reverse is derived at read time;
// - unparseable relation targets keep to_code_raw with to_id NULL;
//   parseable-but-unknown targets get a stub standard row.

import type pg from 'pg';
import { withTransaction } from '../db.js';
import {
  parseStandardCode,
  expandParsedCode,
  type ExpandedCodeRecord,
  type ParsedStandardCode
} from './code-parser.js';

export type StandardSource = 'VSQI' | 'TCVN_VN' | 'TCVN_QT';
export type StandardStatus = 'Active' | 'Withdrawn' | 'Unknown';
export type DetailLevel = 'stub' | 'summary' | 'full' | 'manual';

const LEVEL_RANK: Record<DetailLevel, number> = {
  stub: 0,
  summary: 1,
  full: 2,
  manual: 3
};

/** Search-result item as mapped by Reverse_proxy (raw is never sent/stored). */
export interface IngestSearchItem {
  code: string;
  name?: string | null;
  englishName?: string | null;
  year?: number | null;
  status?: string | null;
  detailUrl?: string | null;
  ics?: string[] | null;
}

export interface IngestRelation {
  type: string;
  code?: string | null;
  text?: string | null;
  url?: string | null;
}

export interface IngestDetail extends IngestSearchItem {
  issuedDate?: string | null;
  effectiveDate?: string | null;
  replaces?: string | null;
  replacedBy?: string | null;
  ics?: string[] | null;
  attributes?: unknown;
  relations?: IngestRelation[] | null;
}

export interface StandardRow {
  id: string;
  org: string;
  number: string;
  part: string | null;
  year: number | null;
  amendment: string | null;
  suffix: string | null;
  normalized_code: string;
  base_key: string;
  code_display: string;
  title_vi: string | null;
  title_en: string | null;
  status: StandardStatus;
  issued_date: string | null;
  effective_date: string | null;
  ics: string[] | null;
  detail_level: DetailLevel;
  parse_confidence: string | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface StandardFields {
  org: string;
  number: string;
  part: string | null;
  year: number | null;
  amendment: string | null;
  suffix: string | null;
  normalized_code: string;
  base_key: string;
  code_display: string;
  title_vi: string | null;
  title_en: string | null;
  status: StandardStatus;
  issued_date: string | null;
  effective_date: string | null;
  ics: string[] | null;
  detail_level: DetailLevel;
  parse_confidence: number;
}

export function normalizeStatus(raw: string | null | undefined): StandardStatus {
  if (!raw) return 'Unknown';
  const s = raw.trim().toLowerCase();
  if (s === 'active' || s.includes('còn hiệu lực') || s.includes('con hieu luc')) {
    return 'Active';
  }
  if (
    s === 'withdrawn' ||
    s.includes('withdraw') ||
    s.includes('hết hiệu lực') ||
    s.includes('het hieu luc') ||
    s.includes('bị hủy') ||
    s.includes('bi huy')
  ) {
    return 'Withdrawn';
  }
  return 'Unknown';
}

/**
 * Split a TCVN_QT `replaces` string: codes separated by '*', each possibly
 * followed by a "(date)" note, e.g.
 * "ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)".
 */
export function splitReplacesString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('*')
    .map((part) => part.trim().replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter((part) => part.length > 0);
}

function titlesFor(
  item: IngestSearchItem,
  source: StandardSource
): { title_vi: string | null; title_en: string | null } {
  const name = item.name?.trim() || null;
  const english = item.englishName?.trim() || null;
  if (source === 'TCVN_QT') {
    // TCVN_QT `name` is the English title (mapper sets name = ti).
    return { title_vi: null, title_en: english ?? name };
  }
  return { title_vi: name, title_en: english };
}

function fieldsFromParsed(
  parsed: ParsedStandardCode,
  record: ExpandedCodeRecord,
  item: IngestSearchItem,
  source: StandardSource,
  level: DetailLevel,
  detail?: IngestDetail
): StandardFields {
  const { title_vi, title_en } = titlesFor(item, source);
  const icsFromRelations = (detail?.relations ?? [])
    .filter((r) => r.type === 'ics')
    .map((r) => (r.text ?? r.code ?? '').trim())
    .filter((v) => v.length > 0);
  const ics = detail?.ics ?? item.ics ?? (icsFromRelations.length > 0 ? icsFromRelations : null);
  return {
    org: parsed.org_normalized ?? 'UNKNOWN',
    number: parsed.std_main_number ?? '',
    part: record.part,
    year: parsed.std_year,
    amendment: parsed.amendment,
    suffix: parsed.suffix,
    normalized_code: record.normalized_code,
    base_key: record.base_key,
    code_display: item.code.trim(),
    title_vi,
    title_en,
    status: normalizeStatus(item.status),
    issued_date: detail?.issuedDate?.trim() || null,
    effective_date: detail?.effectiveDate?.trim() || null,
    ics: ics && ics.length > 0 ? ics : null,
    detail_level: level,
    parse_confidence: record.parse_confidence
  };
}

const nonEmpty = (v: string | null | undefined): string | null =>
  v !== null && v !== undefined && v.trim().length > 0 ? v : null;

/**
 * Pure merge of an incoming record into an existing row (spec 4.3).
 * Returns the field set to store. Rules:
 * - existing 'manual' → keep everything (caller only bumps last_verified_at);
 * - incoming level >= existing level → incoming non-empty wins, empty never
 *   overwrites; detail_level rises to the higher of the two;
 * - incoming level < existing → only fill fields that are still empty;
 * - status: TCVN beats VSQI — a VSQI status never replaces a status that
 *   came from a TCVN source (existingSources tells us), and 'Unknown' never
 *   replaces a known status.
 */
export function mergeStandardFields(
  existing: StandardRow,
  incoming: StandardFields,
  incomingSource: StandardSource,
  existingSources: readonly string[]
): StandardFields {
  const existingFields: StandardFields = {
    org: existing.org,
    number: existing.number,
    part: existing.part,
    year: existing.year,
    amendment: existing.amendment,
    suffix: existing.suffix,
    normalized_code: existing.normalized_code,
    base_key: existing.base_key,
    code_display: existing.code_display,
    title_vi: existing.title_vi,
    title_en: existing.title_en,
    status: existing.status,
    issued_date: existing.issued_date,
    effective_date: existing.effective_date,
    ics: existing.ics,
    detail_level: existing.detail_level,
    parse_confidence:
      existing.parse_confidence !== null ? Number(existing.parse_confidence) : 0
  };
  if (existing.detail_level === 'manual') return existingFields;

  const incomingWins = LEVEL_RANK[incoming.detail_level] >= LEVEL_RANK[existing.detail_level];
  const pick = <T>(inc: T | null, cur: T | null): T | null =>
    incomingWins ? (inc ?? cur) : (cur ?? inc);
  const pickText = (inc: string | null, cur: string | null): string | null =>
    incomingWins ? (nonEmpty(inc) ?? cur) : (nonEmpty(cur) ?? inc);

  let status = pick(incoming.status === 'Unknown' ? null : incoming.status, existing.status) ?? 'Unknown';
  if (
    incomingSource === 'VSQI' &&
    existing.status !== 'Unknown' &&
    existingSources.some((s) => s === 'TCVN_VN' || s === 'TCVN_QT')
  ) {
    status = existing.status;
  }

  return {
    org: existingFields.org,
    number: existingFields.number,
    part: pick(incoming.part, existing.part),
    year: pick(incoming.year, existing.year),
    amendment: pickText(incoming.amendment, existing.amendment),
    suffix: pickText(incoming.suffix, existing.suffix),
    normalized_code: existingFields.normalized_code,
    base_key: existingFields.base_key,
    code_display: pickText(incoming.code_display, existing.code_display) ?? existing.code_display,
    title_vi: pickText(incoming.title_vi, existing.title_vi),
    title_en: pickText(incoming.title_en, existing.title_en),
    status,
    issued_date: pickText(incoming.issued_date, existing.issued_date),
    effective_date: pickText(incoming.effective_date, existing.effective_date),
    ics: pick(incoming.ics, existing.ics),
    detail_level:
      LEVEL_RANK[incoming.detail_level] > LEVEL_RANK[existing.detail_level]
        ? incoming.detail_level
        : existing.detail_level,
    parse_confidence: Math.max(existingFields.parse_confidence, incoming.parse_confidence)
  };
}

type Queryable = pg.Pool | pg.PoolClient;

async function upsertStandardRow(
  db: Queryable,
  fields: StandardFields,
  source: StandardSource,
  touchVerified: boolean
): Promise<StandardRow> {
  const existingRes = await db.query<StandardRow>(
    'SELECT * FROM standards WHERE normalized_code = $1 FOR UPDATE',
    [fields.normalized_code]
  );
  const existing = existingRes.rows[0];
  if (!existing) {
    const inserted = await db.query<StandardRow>(
      `INSERT INTO standards (
         org, number, part, year, amendment, suffix, normalized_code, base_key,
         code_display, title_vi, title_en, status, issued_date, effective_date,
         ics, detail_level, parse_confidence, last_verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        fields.org,
        fields.number,
        fields.part,
        fields.year,
        fields.amendment,
        fields.suffix,
        fields.normalized_code,
        fields.base_key,
        fields.code_display,
        fields.title_vi,
        fields.title_en,
        fields.status,
        fields.issued_date,
        fields.effective_date,
        fields.ics,
        fields.detail_level,
        fields.parse_confidence,
        touchVerified ? new Date() : null
      ]
    );
    return inserted.rows[0];
  }

  if (existing.detail_level === 'manual') {
    // Human-curated record: ingest never overwrites its fields.
    if (touchVerified) {
      const updated = await db.query<StandardRow>(
        'UPDATE standards SET last_verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
        [existing.id]
      );
      return updated.rows[0];
    }
    return existing;
  }

  const sourcesRes = await db.query<{ source: string }>(
    'SELECT source FROM standard_sources WHERE standard_id = $1',
    [existing.id]
  );
  const merged = mergeStandardFields(
    existing,
    fields,
    source,
    sourcesRes.rows.map((r) => r.source)
  );
  const updated = await db.query<StandardRow>(
    `UPDATE standards SET
       part = $2, year = $3, amendment = $4, suffix = $5, code_display = $6,
       title_vi = $7, title_en = $8, status = $9, issued_date = $10,
       effective_date = $11, ics = $12, detail_level = $13,
       parse_confidence = $14,
       last_verified_at = CASE WHEN $15 THEN now() ELSE last_verified_at END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      existing.id,
      merged.part,
      merged.year,
      merged.amendment,
      merged.suffix,
      merged.code_display,
      merged.title_vi,
      merged.title_en,
      merged.status,
      merged.issued_date,
      merged.effective_date,
      merged.ics,
      merged.detail_level,
      merged.parse_confidence,
      touchVerified
    ]
  );
  return updated.rows[0];
}

/** Ensure a stub standard exists for a parseable relation target. */
async function ensureStub(
  db: Queryable,
  parsed: ParsedStandardCode,
  record: ExpandedCodeRecord,
  rawCode: string
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO standards (
       org, number, part, year, amendment, suffix, normalized_code, base_key,
       code_display, detail_level, parse_confidence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stub',$10)
     ON CONFLICT (normalized_code) DO UPDATE SET normalized_code = EXCLUDED.normalized_code
     RETURNING id`,
    [
      parsed.org_normalized ?? 'UNKNOWN',
      parsed.std_main_number ?? '',
      record.part,
      parsed.std_year,
      parsed.amendment,
      parsed.suffix,
      record.normalized_code,
      record.base_key,
      rawCode.trim(),
      record.parse_confidence
    ]
  );
  return res.rows[0].id;
}

export interface RelationEdge {
  /** 'SELF' for the ingested standard, otherwise the raw target code. */
  fromCodeRaw: string;
  type: string;
  toCodeRaw: string;
}

/**
 * Derive single-direction relation edges from a detail payload.
 * `replacedBy` (string field or relation entry) is inverted into a
 * `replaces` edge FROM the target TO self. `replaces` strings are split
 * on '*' with trailing "(date)" notes stripped. ICS entries are not
 * relations and are skipped here (they feed standards.ics instead).
 */
export function relationEdgesFromDetail(detail: IngestDetail): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const seen = new Set<string>();
  const push = (fromCodeRaw: string, type: string, toCodeRaw: string) => {
    const key = `${fromCodeRaw} ${type} ${toCodeRaw}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ fromCodeRaw, type, toCodeRaw });
  };

  for (const code of splitReplacesString(detail.replaces)) {
    push('SELF', 'replaces', code);
  }
  for (const code of splitReplacesString(detail.replacedBy)) {
    push(code, 'replaces', 'SELF');
  }
  for (const rel of detail.relations ?? []) {
    const type = (rel.type ?? '').trim();
    if (!type || type === 'ics') continue;
    const target = (rel.code ?? rel.text ?? '').trim();
    if (!target) continue;
    if (type === 'replacedBy') {
      for (const code of splitReplacesString(target)) push(code, 'replaces', 'SELF');
    } else if (type === 'replaces') {
      for (const code of splitReplacesString(target)) push('SELF', 'replaces', code);
    } else {
      push('SELF', type, target);
    }
  }
  return edges;
}

async function storeRelationEdge(
  db: Queryable,
  edge: RelationEdge,
  selfId: string,
  source: StandardSource
): Promise<void> {
  const resolve = async (
    codeRaw: string
  ): Promise<Array<{ id: string | null; norm: string }>> => {
    if (codeRaw === 'SELF') {
      const self = await db.query<{ normalized_code: string }>(
        'SELECT normalized_code FROM standards WHERE id = $1',
        [selfId]
      );
      return [{ id: selfId, norm: self.rows[0]?.normalized_code ?? '' }];
    }
    const parsed = parseStandardCode(codeRaw);
    const records = expandParsedCode(parsed);
    if (records.length === 0) {
      return [{ id: null, norm: codeRaw.trim().toUpperCase() }];
    }
    const out: Array<{ id: string | null; norm: string }> = [];
    for (const record of records) {
      const id = await ensureStub(db, parsed, record, codeRaw);
      out.push({ id, norm: record.normalized_code });
    }
    return out;
  };

  const froms = await resolve(edge.fromCodeRaw);
  const tos = await resolve(edge.toCodeRaw);
  for (const from of froms) {
    if (from.id === null) continue; // from_id is NOT NULL; unparseable source side cannot be stored
    for (const to of tos) {
      await db.query(
        `INSERT INTO standard_relations (from_id, type, to_id, to_code_raw, to_norm, source)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (from_id, type, to_norm) DO UPDATE SET
           to_id = COALESCE(EXCLUDED.to_id, standard_relations.to_id),
           to_code_raw = EXCLUDED.to_code_raw,
           source = EXCLUDED.source`,
        [
          from.id,
          edge.type,
          to.id,
          edge.toCodeRaw === 'SELF' ? to.norm : edge.toCodeRaw,
          to.norm,
          source
        ]
      );
    }
  }
}

/**
 * Upsert one search-result item (detail_level 'summary'). Returns the
 * stored standard ids (one per expanded part). Unparseable codes are
 * skipped (returns []) — never invent a key.
 */
export async function upsertStandardFromSearchItem(
  pool: pg.Pool,
  item: IngestSearchItem,
  source: StandardSource
): Promise<string[]> {
  const parsed = parseStandardCode(item.code);
  const records = expandParsedCode(parsed);
  const ids: string[] = [];
  for (const record of records) {
    const fields = fieldsFromParsed(parsed, record, item, source, 'summary');
    const row = await upsertStandardRow(pool, fields, source, false);
    ids.push(row.id);
  }
  return ids;
}

/**
 * Upsert one detail payload (detail_level 'full') in ONE transaction:
 * standards + standard_sources snapshot + standard_relations.
 * The snapshot payload keeps attributes + relations only — `raw` is
 * never stored (the route strips it; this function also whitelists).
 */
export async function upsertStandardFromDetail(
  pool: pg.Pool,
  detail: IngestDetail,
  source: StandardSource
): Promise<string[]> {
  const parsed = parseStandardCode(detail.code);
  const records = expandParsedCode(parsed);
  if (records.length === 0) return [];
  return withTransaction(pool, async (client) => {
    const ids: string[] = [];
    for (const record of records) {
      const fields = fieldsFromParsed(parsed, record, detail, source, 'full', detail);
      const row = await upsertStandardRow(client, fields, source, true);
      ids.push(row.id);
      const payload = {
        attributes: detail.attributes ?? null,
        relations: detail.relations ?? null
      };
      await client.query(
        `INSERT INTO standard_sources (standard_id, source, detail_url, payload, fetched_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (standard_id, source) DO UPDATE SET
           detail_url = EXCLUDED.detail_url,
           payload = EXCLUDED.payload,
           fetched_at = now()`,
        [row.id, source, detail.detailUrl?.trim() || null, JSON.stringify(payload)]
      );
      for (const edge of relationEdgesFromDetail(detail)) {
        await storeRelationEdge(client, edge, row.id, source);
      }
    }
    return ids;
  });
}

export interface LookupResult {
  standard: StandardRow;
  sources: Array<{ source: string; detail_url: string | null; fetched_at: Date }>;
  relations: Array<{
    direction: 'outgoing' | 'incoming';
    type: string;
    to_code_raw: string;
    to_norm: string;
    to_id: string | null;
    from_id: string;
    source: string | null;
  }>;
}

/**
 * Look up by user-typed code. With a year → exact normalized_code match.
 * Without a year → base_key match, newest year first. Returns null when
 * the query does not parse as a code or nothing is stored yet.
 */
export async function lookupByCode(
  pool: pg.Pool,
  query: string
): Promise<LookupResult | null> {
  const parsed = parseStandardCode(query);
  const records = expandParsedCode(parsed);
  if (records.length === 0) return null;
  const record = records[0];
  const hasYear = parsed.std_year !== null;
  const res = hasYear
    ? await pool.query<StandardRow>(
        'SELECT * FROM standards WHERE normalized_code = $1 LIMIT 1',
        [record.normalized_code]
      )
    : await pool.query<StandardRow>(
        `SELECT * FROM standards WHERE base_key = $1
         ORDER BY year DESC NULLS LAST, updated_at DESC LIMIT 1`,
        [record.base_key]
      );
  const standard = res.rows[0];
  if (!standard) return null;
  const sources = await pool.query<{ source: string; detail_url: string | null; fetched_at: Date }>(
    'SELECT source, detail_url, fetched_at FROM standard_sources WHERE standard_id = $1 ORDER BY fetched_at DESC',
    [standard.id]
  );
  const relations = await pool.query<{
    direction: 'outgoing' | 'incoming';
    type: string;
    to_code_raw: string;
    to_norm: string;
    to_id: string | null;
    from_id: string;
    source: string | null;
  }>(
    `SELECT 'outgoing' AS direction, type, to_code_raw, to_norm, to_id, from_id, source
       FROM standard_relations WHERE from_id = $1
     UNION ALL
     SELECT 'incoming' AS direction, type, to_code_raw, to_norm, to_id, from_id, source
       FROM standard_relations WHERE to_id = $1`,
    [standard.id]
  );
  return { standard, sources: sources.rows, relations: relations.rows };
}

/**
 * Append one search_log row. Called ONLY from the ingest path
 * (lookup never logs). No user id / IP is stored.
 */
export async function logSearch(
  pool: pg.Pool,
  entry: { queryNorm: string; orgGuess: string | null; hadResult: boolean }
): Promise<void> {
  await pool.query(
    'INSERT INTO search_log (query_norm, org_guess, had_result) VALUES ($1,$2,$3)',
    [entry.queryNorm, entry.orgGuess, entry.hadResult]
  );
}
