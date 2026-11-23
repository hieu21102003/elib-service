// Standards metadata repository (Bước 1, Phase 2 + đổi hướng khóa gộp
// 2026-11-23).
//
// Owns all SQL for standards / standard_sources / standard_relations /
// search_log. Data is fed gradually from real search/detail requests via
// the internal API — never bulk-crawled.
//
// Merge key: normalized_code / base_key / year / is_amendment come from
// LIGHT normalization of the upstream `code` (light-normalize.ts). The
// full parser (code-parser.ts) only fills optional org/number/part/
// amendment/suffix columns best-effort — parse failure or low
// confidence stores NULLs + the parser's confidence, never blocks
// ingest, never decides the key.
//
// Merge rules (spec 4.3):
// - one standard = one row per normalized_code, one snapshot per source;
// - never overwrite a non-empty field with an empty one;
// - summary never overwrites fields set by full; manual records are never
//   overwritten by ingest (only last_verified_at is touched — manual rows
//   are human-curated, so ingest must not fight the curator);
// - status prefers TCVN sources over VSQI;
// - needs_review is sticky (once flagged, stays until a human clears it);
// - replacement relations are stored in ONE direction only: "A replacedBy
//   B" becomes "B replaces A"; the reverse is derived at read time;
// - yearless relation targets NEVER get a stub with a fake key: the edge
//   stores to_norm + to_base_key with to_id NULL unless a standard with
//   that exact normalized_code already exists (display joins by
//   base_key). Yeared targets still get a stub so the graph stays
//   connected. A yearless record is never overwritten by a later yeared
//   edition — they are different normalized_codes;
// - un-normalizable codes are skipped + logged, never fail the batch.

import type pg from 'pg';
import { withTransaction } from '../db.js';
import { parseStandardCode } from './code-parser.js';
import { lightNormalizeCode, type LightNormalized } from './light-normalize.js';

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
  org: string | null;
  number: string | null;
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
  is_amendment: boolean;
  needs_review: boolean;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface StandardFields {
  org: string | null;
  number: string | null;
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
  is_amendment: boolean;
  needs_review: boolean;
}

export type IngestLogger = (message: string) => void;

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

export interface ReplacesPart {
  /** Code with the trailing "(date)" note stripped. */
  code: string;
  /** Year extracted from a trailing "(YYYY-MM)"/"(YYYY)" note, if any. */
  year: number | null;
  /** Original part text, untouched. */
  raw: string;
  /** Prose corrigendum ("... Technical Corrigendum 1 ...") — never parsed. */
  rawOnly: boolean;
}

const PAREN_YEAR_RE = /\((\d{4})(?:-\d{1,2})?\)\s*$/;
const CORRIGENDUM_PROSE_RE = /technical\s+corrigendum/i;

/**
 * Split a TCVN_QT `replaces` string: codes separated by '*', each
 * possibly followed by a "(date)" note, e.g.
 * "ISO 9001 (2008-11)*ISO/FDIS 9001 (2015-07)*ISO 9001 Technical Corrigendum 1 (2009-07)".
 * The year is taken from the "(YYYY-MM)" note by regex — it becomes the
 * yearField for light normalization of that part.
 */
export function splitReplacesParts(raw: string | null | undefined): ReplacesPart[] {
  if (!raw) return [];
  const parts: ReplacesPart[] = [];
  for (const piece of raw.split('*')) {
    const partRaw = piece.trim();
    if (partRaw.length === 0) continue;
    const yearMatch = PAREN_YEAR_RE.exec(partRaw);
    const code = partRaw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (code.length === 0) continue;
    parts.push({
      code,
      year: yearMatch ? Number(yearMatch[1]) : null,
      raw: partRaw,
      rawOnly: CORRIGENDUM_PROSE_RE.test(partRaw)
    });
  }
  return parts;
}

/**
 * Split a TCVN_QT `replaces` string into bare codes (date notes
 * stripped). Kept for callers that only need the code list.
 */
export function splitReplacesString(raw: string | null | undefined): string[] {
  return splitReplacesParts(raw).map((part) => part.code);
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

/**
 * Best-effort optional columns from the full parser. Only trusted when
 * the parser verified the code (its own confidence threshold);
 * otherwise NULLs. The stored parse_confidence is always the parser's
 * score, so low-confidence rows stay visible as such.
 */
function parserColumns(code: string): {
  org: string | null;
  number: string | null;
  part: string | null;
  amendment: string | null;
  suffix: string | null;
  parse_confidence: number;
} {
  const parsed = parseStandardCode(code);
  const usable = parsed.std_main_number !== null && parsed.verified;
  if (!usable) {
    return {
      org: null,
      number: null,
      part: null,
      amendment: null,
      suffix: null,
      parse_confidence: parsed.confidence_score
    };
  }
  return {
    org: parsed.org_normalized,
    number: parsed.std_main_number,
    part: parsed.std_parts.length > 0 ? parsed.std_parts.join('-') : null,
    amendment: parsed.amendment,
    suffix: parsed.suffix,
    parse_confidence: parsed.confidence_score
  };
}

function fieldsFromItem(
  light: LightNormalized,
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
  const cols = parserColumns(item.code);
  return {
    org: cols.org,
    number: cols.number,
    part: cols.part,
    year: light.year,
    amendment: cols.amendment,
    suffix: cols.suffix,
    normalized_code: light.normalized_code,
    base_key: light.base_key,
    code_display: item.code.trim(),
    title_vi,
    title_en,
    status: normalizeStatus(item.status),
    issued_date: detail?.issuedDate?.trim() || null,
    effective_date: detail?.effectiveDate?.trim() || null,
    ics: ics && ics.length > 0 ? ics : null,
    detail_level: level,
    parse_confidence: cols.parse_confidence,
    is_amendment: light.is_amendment,
    needs_review: light.needs_review
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
 *   replaces a known status;
 * - needs_review is sticky (existing OR incoming);
 * - is_amendment is a pure function of normalized_code, so both sides
 *   agree; incoming wins by construction.
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
      existing.parse_confidence !== null ? Number(existing.parse_confidence) : 0,
    is_amendment: existing.is_amendment,
    needs_review: existing.needs_review
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
    org: pickText(incoming.org, existing.org),
    number: pickText(incoming.number, existing.number),
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
    parse_confidence: Math.max(existingFields.parse_confidence, incoming.parse_confidence),
    is_amendment: incoming.is_amendment,
    needs_review: existing.needs_review || incoming.needs_review
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
         ics, detail_level, parse_confidence, is_amendment, needs_review,
         last_verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        fields.is_amendment,
        fields.needs_review,
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
       org = $2, number = $3, part = $4, year = $5, amendment = $6,
       suffix = $7, code_display = $8, title_vi = $9, title_en = $10,
       status = $11, issued_date = $12, effective_date = $13, ics = $14,
       detail_level = $15, parse_confidence = $16, is_amendment = $17,
       needs_review = $18,
       last_verified_at = CASE WHEN $19 THEN now() ELSE last_verified_at END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      existing.id,
      merged.org,
      merged.number,
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
      merged.is_amendment,
      merged.needs_review,
      touchVerified
    ]
  );
  return updated.rows[0];
}

/**
 * Ensure a stub standard exists for a YEARED relation target. Yearless
 * targets never reach here — no stub with a fake key.
 */
async function ensureStub(
  db: Queryable,
  light: LightNormalized,
  rawCode: string
): Promise<string> {
  const cols = parserColumns(rawCode);
  const res = await db.query<{ id: string }>(
    `INSERT INTO standards (
       org, number, part, year, amendment, suffix, normalized_code, base_key,
       code_display, detail_level, parse_confidence, is_amendment, needs_review
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stub',$10,$11,$12)
     ON CONFLICT (normalized_code) DO UPDATE SET normalized_code = EXCLUDED.normalized_code
     RETURNING id`,
    [
      cols.org,
      cols.number,
      cols.part,
      light.year,
      cols.amendment,
      cols.suffix,
      light.normalized_code,
      light.base_key,
      rawCode.trim(),
      cols.parse_confidence,
      light.is_amendment,
      light.needs_review
    ]
  );
  return res.rows[0].id;
}

export interface RelationEdge {
  /** 'SELF' for the ingested standard, otherwise the raw target code. */
  fromCodeRaw: string;
  /** Year extracted from a "(YYYY-MM)" note on the from side, if any. */
  fromYear: number | null;
  type: string;
  toCodeRaw: string;
  /** Year extracted from a "(YYYY-MM)" note on the to side, if any. */
  toYear: number | null;
  /**
   * Prose target that must not be parsed (e.g. "ISO 9001 Technical
   * Corrigendum 1 (2009-07)"): store to_code_raw verbatim, to_id NULL.
   */
  toRawOnly: boolean;
}

/**
 * Derive single-direction relation edges from a detail payload.
 * `replacedBy` (string field or relation entry) is inverted into a
 * `replaces` edge FROM the target TO self. `replaces` strings are split
 * on '*' with the year taken from each part's "(YYYY-MM)" note. ICS
 * entries are not relations and are skipped here (they feed
 * standards.ics instead).
 */
export function relationEdgesFromDetail(detail: IngestDetail): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: RelationEdge) => {
    const key = `${edge.fromCodeRaw} ${edge.type} ${edge.toCodeRaw}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  const fromParts = (
    parts: ReplacesPart[],
    make: (part: ReplacesPart) => RelationEdge
  ) => {
    for (const part of parts) push(make(part));
  };

  fromParts(splitReplacesParts(detail.replaces), (part) => ({
    fromCodeRaw: 'SELF',
    fromYear: null,
    type: 'replaces',
    toCodeRaw: part.rawOnly ? part.raw : part.code,
    toYear: part.year,
    toRawOnly: part.rawOnly
  }));
  fromParts(splitReplacesParts(detail.replacedBy), (part) => ({
    fromCodeRaw: part.code,
    fromYear: part.year,
    type: 'replaces',
    toCodeRaw: 'SELF',
    toYear: null,
    toRawOnly: false
  }));
  for (const rel of detail.relations ?? []) {
    const type = (rel.type ?? '').trim();
    if (!type || type === 'ics') continue;
    const target = (rel.code ?? rel.text ?? '').trim();
    if (!target) continue;
    if (type === 'replacedBy') {
      fromParts(splitReplacesParts(target), (part) => ({
        fromCodeRaw: part.code,
        fromYear: part.year,
        type: 'replaces',
        toCodeRaw: 'SELF',
        toYear: null,
        toRawOnly: false
      }));
    } else if (type === 'replaces') {
      fromParts(splitReplacesParts(target), (part) => ({
        fromCodeRaw: 'SELF',
        fromYear: null,
        type: 'replaces',
        toCodeRaw: part.rawOnly ? part.raw : part.code,
        toYear: part.year,
        toRawOnly: part.rawOnly
      }));
    } else {
      push({
        fromCodeRaw: 'SELF',
        fromYear: null,
        type,
        toCodeRaw: target,
        toYear: null,
        toRawOnly: false
      });
    }
  }
  return edges;
}

interface ResolvedCode {
  id: string | null;
  norm: string;
  baseKey: string;
}

/**
 * Resolve a relation endpoint code to a standard id.
 * - exact normalized_code already stored -> that id;
 * - yeared + unknown -> create a stub (real key, graph stays connected);
 * - yearless + unknown -> id NULL, NO stub (display joins by base_key);
 * - un-normalizable -> id NULL, norm = UPPER(raw).
 */
async function resolveCode(
  db: Queryable,
  codeRaw: string,
  yearField: number | null
): Promise<ResolvedCode> {
  const light = lightNormalizeCode(codeRaw, yearField);
  if (light === null) {
    const upper = codeRaw.trim().toUpperCase();
    return { id: null, norm: upper, baseKey: upper };
  }
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM standards WHERE normalized_code = $1',
    [light.normalized_code]
  );
  if (existing.rows[0]) {
    return { id: existing.rows[0].id, norm: light.normalized_code, baseKey: light.base_key };
  }
  if (light.year !== null) {
    const id = await ensureStub(db, light, codeRaw);
    return { id, norm: light.normalized_code, baseKey: light.base_key };
  }
  return { id: null, norm: light.normalized_code, baseKey: light.base_key };
}

async function storeRelationEdge(
  db: Queryable,
  edge: RelationEdge,
  selfId: string,
  source: StandardSource
): Promise<void> {
  const resolveSide = async (
    codeRaw: string,
    yearField: number | null
  ): Promise<ResolvedCode> => {
    if (codeRaw === 'SELF') {
      const self = await db.query<{ normalized_code: string; base_key: string }>(
        'SELECT normalized_code, base_key FROM standards WHERE id = $1',
        [selfId]
      );
      return {
        id: selfId,
        norm: self.rows[0]?.normalized_code ?? '',
        baseKey: self.rows[0]?.base_key ?? ''
      };
    }
    return resolveCode(db, codeRaw, yearField);
  };

  const from = await resolveSide(edge.fromCodeRaw, edge.fromYear);
  if (from.id === null) return; // from_id is NOT NULL; unresolved source side cannot be stored

  let to: ResolvedCode;
  if (edge.toRawOnly) {
    // Prose corrigendum: keep the raw text, never parse, never resolve.
    const light = lightNormalizeCode(
      edge.toCodeRaw.replace(/\s*\([^)]*\)\s*$/, '').trim()
    );
    const upper = edge.toCodeRaw.trim().toUpperCase();
    to = {
      id: null,
      norm: light?.normalized_code ?? upper,
      baseKey: light?.base_key ?? upper
    };
  } else {
    to = await resolveSide(edge.toCodeRaw, edge.toYear);
  }

  await db.query(
    `INSERT INTO standard_relations (from_id, type, to_id, to_code_raw, to_norm, to_base_key, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (from_id, type, to_norm) DO UPDATE SET
       to_id = COALESCE(EXCLUDED.to_id, standard_relations.to_id),
       to_code_raw = EXCLUDED.to_code_raw,
       to_base_key = EXCLUDED.to_base_key,
       source = EXCLUDED.source`,
    [
      from.id,
      edge.type,
      to.id,
      edge.toCodeRaw === 'SELF' ? to.norm : edge.toCodeRaw,
      to.norm,
      to.baseKey,
      source
    ]
  );
}

/**
 * Upsert one search-result item (detail_level 'summary'). Returns the
 * stored standard id, or [] when the code is un-normalizable (skipped +
 * logged — never invent a key, never fail the batch).
 */
export async function upsertStandardFromSearchItem(
  pool: pg.Pool,
  item: IngestSearchItem,
  source: StandardSource,
  log?: IngestLogger
): Promise<string[]> {
  const light = lightNormalizeCode(item.code, item.year ?? null);
  if (light === null) {
    log?.(`standards ingest: bỏ qua mã không chuẩn hóa được ${JSON.stringify(item.code)} (${source})`);
    return [];
  }
  const fields = fieldsFromItem(light, item, source, 'summary');
  const row = await upsertStandardRow(pool, fields, source, false);
  return [row.id];
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
  source: StandardSource,
  log?: IngestLogger
): Promise<string[]> {
  const light = lightNormalizeCode(detail.code, detail.year ?? null);
  if (light === null) {
    log?.(`standards ingest: bỏ qua detail mã không chuẩn hóa được ${JSON.stringify(detail.code)} (${source})`);
    return [];
  }
  return withTransaction(pool, async (client) => {
    const fields = fieldsFromItem(light, detail, source, 'full', detail);
    const row = await upsertStandardRow(client, fields, source, true);
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
    return [row.id];
  });
}

export interface LookupRelation {
  direction: 'outgoing' | 'incoming';
  type: string;
  to_code_raw: string;
  to_norm: string;
  to_base_key: string | null;
  to_id: string | null;
  from_id: string;
  source: string | null;
}

export interface LookupResult {
  /** Top-ranked edition. */
  standard: StandardRow;
  /** All matching editions, newest first (amendment/FDIS below official). */
  editions: StandardRow[];
  sources: Array<{ source: string; detail_url: string | null; fetched_at: Date }>;
  relations: LookupRelation[];
}

const EDITION_ORDER = `ORDER BY year DESC NULLS LAST, is_amendment ASC,
  (normalized_code LIKE '%FDIS%') ASC, updated_at DESC`;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Look up by user-typed code, normalized with the same light function.
 * - query carries ":YYYY" -> exact normalized_code match, else prefix;
 * - no year -> base_key match returning ALL editions, newest first,
 *   amendment and FDIS below the official edition; else prefix match;
 * - no code match (or un-normalizable query) -> trigram fallback on
 *   title (f_unaccent + LIKE, same pattern as document search).
 */
export async function lookupByCode(
  pool: pg.Pool,
  query: string
): Promise<LookupResult | null> {
  const light = lightNormalizeCode(query);
  let rows: StandardRow[] = [];
  if (light !== null) {
    if (light.year !== null) {
      const exact = await pool.query<StandardRow>(
        'SELECT * FROM standards WHERE normalized_code = $1',
        [light.normalized_code]
      );
      rows = exact.rows;
      if (rows.length === 0) {
        const prefix = await pool.query<StandardRow>(
          `SELECT * FROM standards WHERE normalized_code LIKE $1 ESCAPE '\\' ${EDITION_ORDER}`,
          [`${escapeLike(light.normalized_code)}%`]
        );
        rows = prefix.rows;
      }
    } else {
      const byBase = await pool.query<StandardRow>(
        `SELECT * FROM standards WHERE base_key = $1 ${EDITION_ORDER}`,
        [light.base_key]
      );
      rows = byBase.rows;
      if (rows.length === 0) {
        const prefix = await pool.query<StandardRow>(
          `SELECT * FROM standards WHERE normalized_code LIKE $1 ESCAPE '\\' ${EDITION_ORDER}`,
          [`${escapeLike(light.normalized_code)}%`]
        );
        rows = prefix.rows;
      }
    }
  }
  if (rows.length === 0) {
    const byTitle = await pool.query<StandardRow>(
      `SELECT * FROM standards
        WHERE f_unaccent(lower(COALESCE(title_vi, ''))) LIKE '%' || f_unaccent(lower($1)) || '%'
           OR f_unaccent(lower(COALESCE(title_en, ''))) LIKE '%' || f_unaccent(lower($1)) || '%'
        ${EDITION_ORDER} LIMIT 10`,
      [query.trim()]
    );
    rows = byTitle.rows;
  }
  const standard = rows[0];
  if (!standard) return null;
  const sources = await pool.query<{ source: string; detail_url: string | null; fetched_at: Date }>(
    'SELECT source, detail_url, fetched_at FROM standard_sources WHERE standard_id = $1 ORDER BY fetched_at DESC',
    [standard.id]
  );
  const relations = await pool.query<LookupRelation>(
    `SELECT 'outgoing' AS direction, type, to_code_raw, to_norm, to_base_key, to_id, from_id, source
       FROM standard_relations WHERE from_id = $1
     UNION ALL
     SELECT 'incoming' AS direction, type, to_code_raw, to_norm, to_base_key, to_id, from_id, source
       FROM standard_relations WHERE to_id = $1`,
    [standard.id]
  );
  return { standard, editions: rows, sources: sources.rows, relations: relations.rows };
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
