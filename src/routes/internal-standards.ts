// Internal standards-metadata API (Bước 1, Phase 2).
//
// These routes live under /internal/* — deliberately NOT /api/*, because
// Reverse_proxy proxies /api/elib/* to browsers; /internal/* is reachable
// only inside the Docker network (elib-net) and additionally requires the
// X-Internal-Token shared secret. The token is compared in constant time
// (SHA-256 digests + timingSafeEqual) and is never logged, including on
// mismatch. When STANDARDS_INTERNAL_TOKEN is not configured the routes
// answer 503 (feature off).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { parseStandardCode, buildNormalizedCode } from '../standards/code-parser.js';
import {
  upsertStandardFromSearchItem,
  upsertStandardFromDetail,
  lookupByCode,
  logSearch,
  type IngestDetail,
  type IngestSearchItem,
  type StandardSource
} from '../standards/repository.js';

const BODY_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MB — one results page / one detail
const MAX_ITEMS_PER_INGEST = 100;

const sourceSchema = z.enum(['VSQI', 'TCVN_VN', 'TCVN_QT']);

const searchItemSchema = z.object({
  code: z.string().trim().min(1).max(200),
  name: z.string().max(2000).nullable().optional(),
  englishName: z.string().max(2000).nullable().optional(),
  year: z.number().int().min(1000).max(9999).nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  detailUrl: z.string().max(2000).nullable().optional(),
  ics: z.array(z.string().max(50)).max(50).nullable().optional()
});

const relationSchema = z.object({
  type: z.string().trim().min(1).max(100),
  code: z.string().max(500).nullable().optional(),
  text: z.string().max(2000).nullable().optional(),
  url: z.string().max(2000).nullable().optional()
});

const detailSchema = searchItemSchema.extend({
  issuedDate: z.string().max(50).nullable().optional(),
  effectiveDate: z.string().max(50).nullable().optional(),
  replaces: z.string().max(5000).nullable().optional(),
  replacedBy: z.string().max(5000).nullable().optional(),
  // attributes are stored verbatim in the snapshot payload; cap the array.
  attributes: z.array(z.unknown()).max(500).nullable().optional(),
  relations: z.array(relationSchema).max(500).nullable().optional()
  // NOTE: `raw` is intentionally absent — zod strips unknown keys, so a
  // raw payload sent by a buggy caller is dropped, never stored.
});

const ingestSchema = z
  .object({
    kind: z.enum(['search', 'detail']),
    source: sourceSchema,
    query: z.string().max(500).optional(),
    hadResult: z.boolean().optional(),
    items: z.array(searchItemSchema).max(MAX_ITEMS_PER_INGEST).optional(),
    detail: detailSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'search' && value.items === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind=search requires items' });
    }
    if (value.kind === 'detail' && value.detail === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind=detail requires detail' });
    }
  });

const lookupQuerySchema = z.object({
  q: z.string().trim().min(1).max(500)
});

/** Constant-time token check. Hashes both sides so length never leaks. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function registerInternalStandardsRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  cfg: AppConfig
): void {
  const guard = async (request: FastifyRequest): Promise<void> => {
    if (cfg.standardsInternalToken === null) {
      throw new AppError(
        503,
        'STANDARDS_DISABLED',
        'API metadata tiêu chuẩn chưa được bật (thiếu STANDARDS_INTERNAL_TOKEN).'
      );
    }
    const provided = request.headers['x-internal-token'];
    const headerValue = Array.isArray(provided) ? provided[0] : provided;
    if (!tokenMatches(headerValue, cfg.standardsInternalToken)) {
      // Never log the provided or expected token.
      throw new AppError(401, 'INTERNAL_UNAUTHORIZED', 'Token nội bộ không hợp lệ.');
    }
  };

  app.post(
    '/internal/standards/ingest',
    { preHandler: guard, bodyLimit: BODY_LIMIT_BYTES },
    async (request) => {
      const body = ingestSchema.parse(request.body);
      const source = body.source as StandardSource;
      if (body.kind === 'search') {
        const items = (body.items ?? []) as IngestSearchItem[];
        let stored = 0;
        for (const item of items) {
          const ids = await upsertStandardFromSearchItem(pool, item, source);
          stored += ids.length;
        }
        // search_log is written ONLY here (ingest), with had_result from
        // the caller (Reverse_proxy knows the final merged result).
        const query = body.query ?? '';
        const parsedQuery = parseStandardCode(query);
        await logSearch(pool, {
          queryNorm:
            buildNormalizedCode(parsedQuery) ?? query.trim().replace(/\s+/g, ' ').toUpperCase(),
          orgGuess: parsedQuery.org_normalized,
          hadResult: body.hadResult ?? items.length > 0
        });
        return { ok: true, stored };
      }
      const detail = body.detail as IngestDetail;
      const ids = await upsertStandardFromDetail(pool, detail, source);
      return { ok: true, stored: ids.length };
    }
  );

  app.get('/internal/standards/lookup', { preHandler: guard }, async (request) => {
    const { q } = lookupQuerySchema.parse(request.query);
    const result = await lookupByCode(pool, q);
    if (result === null) {
      return { found: false };
    }
    const s = result.standard;
    return {
      found: true,
      standard: {
        id: s.id,
        org: s.org,
        number: s.number,
        part: s.part,
        year: s.year,
        amendment: s.amendment,
        suffix: s.suffix,
        normalizedCode: s.normalized_code,
        baseKey: s.base_key,
        codeDisplay: s.code_display,
        titleVi: s.title_vi,
        titleEn: s.title_en,
        status: s.status,
        issuedDate: s.issued_date,
        effectiveDate: s.effective_date,
        ics: s.ics,
        detailLevel: s.detail_level,
        parseConfidence: s.parse_confidence !== null ? Number(s.parse_confidence) : null,
        lastVerifiedAt: s.last_verified_at?.toISOString() ?? null,
        updatedAt: s.updated_at.toISOString()
      },
      sources: result.sources.map((row) => ({
        source: row.source,
        detailUrl: row.detail_url,
        fetchedAt: row.fetched_at.toISOString()
      })),
      relations: result.relations.map((row) => ({
        direction: row.direction,
        type: row.type,
        toCodeRaw: row.to_code_raw,
        toNorm: row.to_norm,
        toId: row.to_id,
        fromId: row.from_id,
        source: row.source
      }))
    };
  });
}
