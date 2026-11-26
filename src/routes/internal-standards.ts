// Internal standards-metadata API (Bước 1, Phase 2).
//
// These routes live under /internal/* — deliberately NOT /api/*, because
// Reverse_proxy proxies /api/elib/* to browsers; /internal/* is reachable
// only inside the Docker network (elib-net) and additionally requires the
// X-Internal-Token shared secret. The token is compared in constant time
// (SHA-256 digests + timingSafeEqual) and is never logged, including on
// mismatch. When STANDARDS_INTERNAL_TOKEN is not configured the routes
// answer 503 (feature off).
//
// Wire shapes come from src/standards/contract.ts — the single source of
// truth shared with Reverse_proxy. Ingest accepts a multi-source search
// page in ONE request ({sources:[{source, items}]}) and writes exactly
// ONE search_log row per search request; the legacy single-source shape
// ({source, items}) is still accepted, with `log:false` available so a
// caller fanning one search into several legacy requests still produces
// exactly one search_log row.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { parseStandardCode } from '../standards/code-parser.js';
import {
  IngestRequestSchema,
  LookupResponseSchema,
  type IngestSourceGroup
} from '../standards/contract.js';
import { lightNormalizeCode } from '../standards/light-normalize.js';
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
      const body = IngestRequestSchema.parse(request.body);
      const log = (message: string) => request.log.warn(message);
      if (body.kind === 'search') {
        // Normalize both accepted shapes into source groups. The schema
        // guarantees exactly one of them is present.
        const groups: IngestSourceGroup[] =
          body.sources ??
          [{ source: body.source as StandardSource, items: body.items ?? [] }];
        let stored = 0;
        let total = 0;
        for (const group of groups) {
          const source = group.source as StandardSource;
          for (const item of group.items as IngestSearchItem[]) {
            total += 1;
            const ids = await upsertStandardFromSearchItem(pool, item, source, log);
            stored += ids.length;
          }
        }
        // search_log is written ONLY here (ingest), with had_result from
        // the caller (Reverse_proxy knows the final merged result) —
        // exactly ONE row per search request, whatever the shape,
        // unless the caller opts out with log:false.
        if (body.log !== false) {
          const query = body.query ?? '';
          await logSearch(pool, {
            queryNorm:
              lightNormalizeCode(query)?.normalized_code ??
              query.trim().replace(/\s+/g, ' ').toUpperCase(),
            // org_guess is best-effort only — the full parser never
            // decides keys, it just hints the organization for the log.
            orgGuess: parseStandardCode(query).org_normalized,
            hadResult: body.hadResult ?? total > 0
          });
        }
        return { ok: true, stored, skipped: total - stored };
      }
      const detail = body.detail as IngestDetail;
      const ids = await upsertStandardFromDetail(
        pool,
        detail,
        body.source as StandardSource,
        log
      );
      return { ok: true, stored: ids.length, skipped: ids.length === 0 ? 1 : 0 };
    }
  );

  app.get('/internal/standards/lookup', { preHandler: guard }, async (request) => {
    const { q } = lookupQuerySchema.parse(request.query);
    const result = await lookupByCode(pool, q);
    if (result === null) {
      return { found: false };
    }
    const s = result.standard;
    // Parsed against the shared contract so any drift between this
    // route and contract.ts fails loudly in tests instead of silently
    // breaking Reverse_proxy.
    return LookupResponseSchema.parse({
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
        isAmendment: s.is_amendment,
        needsReview: s.needs_review,
        lastVerifiedAt: s.last_verified_at?.toISOString() ?? null,
        updatedAt: s.updated_at.toISOString()
      },
      // All matching editions, newest first (amendment/FDIS below the
      // official edition) — `standard` above is editions[0]. Titles are
      // included so the caller can render DB-only search results for
      // every edition, not just the top one.
      editions: result.editions.map((row) => ({
        id: row.id,
        normalizedCode: row.normalized_code,
        baseKey: row.base_key,
        codeDisplay: row.code_display,
        year: row.year,
        status: row.status,
        titleVi: row.title_vi,
        titleEn: row.title_en,
        isAmendment: row.is_amendment,
        needsReview: row.needs_review,
        detailLevel: row.detail_level,
        lastVerifiedAt: row.last_verified_at?.toISOString() ?? null
      })),
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
        toBaseKey: row.to_base_key,
        toId: row.to_id,
        fromId: row.from_id,
        source: row.source,
        otherNormalizedCode: row.other_normalized_code,
        otherCodeDisplay: row.other_code_display
      })),
      replaces: result.replaces,
      replacedBy: result.replacedBy
    });
  });
}
