// Light code normalization — THE merge key for standards metadata
// (user decision 2026-11-23, "Đổi hướng khóa gộp" in
// ~/workspace/standards-metadata-db-plan.md).
//
// Ingest keys come from LIGHT normalization of the upstream `code`
// string, NOT from the full parser (code-parser.ts). The full parser
// only fills optional org/number/part/amendment columns best-effort.
// This function is mirrored by Reverse_proxy (shared fixture:
// tests/fixtures/code-normalize-shared.json) — elib is the source of
// truth for normalized_code.
//
// Rules:
// - uppercase, strip Vietnamese diacritics (NFD + drop combining marks,
//   đ/Đ -> D), remove all whitespace/newlines;
// - slash rule: a `/` is dropped iff the char before AND after it are
//   both letters (ISO/TS -> ISOTS, TCVN/ISO -> TCVNISO); kept when it
//   follows a digit (suffixes /Amd 1, /BXD, /AC). Suffixes are never
//   dropped;
// - "code has year" ONLY when `:YYYY` (4 digits) sits at the end or
//   immediately before a `/`. Two-digit years ("14 TCN 58-88") stay in
//   the key untouched — never inferred as 1988;
// - code has `:YYYY` != yearField -> key from code, needs_review;
// - code has no `:YYYY` but yearField present -> append `:yearField`,
//   EXCEPT amendment-suffixed codes (no append, needs_review);
// - base_key = normalized_code up to the `:year` segment;
// - is_amendment by simple regex (/AMD, /COR, /AC, +A\d);
// - un-normalizable (empty, or no digit — a standard code always
//   carries a number; letters-only strings like "abc"/"TCVN" are not
//   codes) -> null. Ingest skips + logs those, never fails the batch.

export interface LightNormalized {
  normalized_code: string;
  base_key: string;
  year: number | null;
  is_amendment: boolean;
  needs_review: boolean;
}

const LETTER_RE = /\p{L}/u;
const AMENDMENT_RE = /(?:\/AMD|\/COR|\/AC|\+A\d)/;
const YEAR_SEGMENT_RE = /:(\d{4})(?=\/|$)/;

function stripDiacriticsUpper(text: string): string {
  return text
    .replace(/[đĐ]/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase();
}

function applySlashRule(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/') {
      const before = i > 0 ? text[i - 1] : '';
      const after = i + 1 < text.length ? text[i + 1] : '';
      if (LETTER_RE.test(before) && LETTER_RE.test(after)) {
        continue; // letter/letter -> drop (ISO/TS = ISO TS)
      }
    }
    out += ch;
  }
  return out;
}

export function lightNormalizeCode(
  code: string,
  yearField?: number | null
): LightNormalized | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;

  const light = applySlashRule(stripDiacriticsUpper(trimmed).replace(/\s+/g, ''));
  // A standard code always contains a number; letters-only or
  // punctuation-only strings are not codes.
  if (!/\d/.test(light)) return null;

  const isAmendment = AMENDMENT_RE.test(light);
  const yearMatch = YEAR_SEGMENT_RE.exec(light);
  const fieldYear =
    typeof yearField === 'number' && Number.isInteger(yearField) ? yearField : null;

  if (yearMatch) {
    const codeYear = Number(yearMatch[1]);
    return {
      normalized_code: light,
      base_key: light.slice(0, yearMatch.index),
      year: codeYear,
      is_amendment: isAmendment,
      needs_review: fieldYear !== null && fieldYear !== codeYear
    };
  }

  if (fieldYear !== null) {
    if (isAmendment) {
      // Amendment suffix without ":year": do not append the field year
      // (it would fake the base edition's key) — flag for review.
      return {
        normalized_code: light,
        base_key: light,
        year: fieldYear,
        is_amendment: true,
        needs_review: true
      };
    }
    return {
      normalized_code: `${light}:${fieldYear}`,
      base_key: light,
      year: fieldYear,
      is_amendment: false,
      needs_review: false
    };
  }

  return {
    normalized_code: light,
    base_key: light,
    year: null,
    is_amendment: isAmendment,
    needs_review: false
  };
}

/** FDIS drafts sort below the official edition in lookup results. */
export function isFdisCode(normalizedCode: string): boolean {
  return normalizedCode.includes('FDIS');
}
