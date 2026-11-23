// Light code normalization — THE merge key for standards metadata
// (user decision 2026-11-23, "Đổi hướng khóa gộp" + "5 luật bổ sung"
// in ~/workspace/standards-metadata-db-plan.md).
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
//   đ/Đ -> D), remove whitespace/newlines — EXCEPT whitespace between
//   two digit groups, which keeps a "-" separator ("TCVN 1234 12" ->
//   "TCVN1234-12", needs_review). Letter<->digit boundaries still join;
// - slash rule: a `/` is dropped iff the char before AND after it are
//   both letters (ISO/TS -> ISOTS, TCVN/ISO -> TCVNISO, GB/T -> GBT);
//   kept when it follows a digit (suffixes /Amd 1, /BXD, /AC). Suffixes
//   are never dropped;
// - skip (null) when the normalized string has no two consecutive
//   letters before a digit: digits-only ("12345"), ICS-like
//   ("93.160"), single-letter org ("T 27"), letters-only ("abc") are
//   not standard codes. Ingest skips + logs those, never fails the
//   batch;
// - "code has year" ONLY when `:YYYY` (4 digits, not followed by
//   another digit) appears; base_key = part before the FIRST `:YYYY`,
//   year = that first year (main edition — "EN 1994-1-1:2004+A1:2010"
//   -> base EN1994-1-1, year 2004). Two-digit years in the code
//   ("14 TCN 58-88") stay untouched unless the dash-year rule below
//   applies;
// - dash-year rule: a trailing `-YYYY` or `/YYYY` (optionally followed
//   by `-MM`) equal to the year field is rewritten to `:YYYY`; the
//   `-MM` month is dropped from the key (month is not part of a
//   standard's identity). A trailing `-YY` counts only when it equals
//   the last two digits of the year field AND no other "-" precedes it
//   (protects part-chapter codes like "EN 1993-1-10" from being read
//   as year 2010); it becomes `:YYYY` with the full field year. A
//   trailing 4-digit dash segment that DISAGREES with the year field
//   stays literal, `:fieldYear` is still appended (code lacks
//   `:YYYY`), and needs_review is set (year conflict). Amendment
//   codes are exempt from the rewrite (their year handling is already
//   needs_review territory);
// - code has `:YYYY` != yearField -> key from code, needs_review;
// - code has no `:YYYY` but yearField present -> append `:yearField`,
//   EXCEPT amendment-suffixed codes (no append, needs_review);
// - needs_review also when the resolved year is outside
//   [1900, current year + 1], and when the leading letter block is a
//   doubled org prefix ("ENEN", "EN EN", "TCVNTCVN") — the doubled
//   form is kept in the key, never collapsed;
// - is_amendment by simple regex (/AMD, /COR, /AC, +A\d).

export interface LightNormalized {
  normalized_code: string;
  base_key: string;
  year: number | null;
  is_amendment: boolean;
  needs_review: boolean;
}

const LETTER_RE = /\p{L}/u;
const AMENDMENT_RE = /(?:\/AMD|\/COR|\/AC|\+A\d)/;
const COLON_YEAR_RE = /:(\d{4})(?!\d)/;
const DASH_YEAR_RE = /[-/](\d{4})(?:-\d{2})?$/;
const DASH_YY_RE = /-(\d{2})$/;
const ORG_LETTERS_RE = /[A-Z]{2}.*\d/;
const LEADING_LETTERS_RE = /^[A-Z]+/;

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

/** Leading letter block repeated twice ("ENEN", "TCVNTCVN"). */
function hasDoubledOrg(light: string): boolean {
  const run = LEADING_LETTERS_RE.exec(light)?.[0] ?? '';
  if (run.length < 4 || run.length % 2 !== 0) return false;
  const half = run.length / 2;
  return run.slice(0, half) === run.slice(half);
}

function yearInRange(year: number): boolean {
  return year >= 1900 && year <= new Date().getFullYear() + 1;
}

export function lightNormalizeCode(
  code: string,
  yearField?: number | null
): LightNormalized | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;

  let text = stripDiacriticsUpper(trimmed);
  // Whitespace between two digit groups keeps a "-" separator instead
  // of joining ("TCVN 1234 12" -> "TCVN1234-12"); flagged for review
  // because the grouping is ambiguous.
  let digitGroupSep = false;
  text = text.replace(/(\d)\s+(\d)/g, (_m, a: string, b: string) => {
    digitGroupSep = true;
    return `${a}-${b}`;
  });
  text = text.replace(/\s+/g, '');
  let light = applySlashRule(text);

  // A standard code carries an org of at least two letters before its
  // number. Digits-only, ICS-like, single-letter and letters-only
  // strings are not codes.
  if (!ORG_LETTERS_RE.test(light)) return null;

  const isAmendment = AMENDMENT_RE.test(light);
  const fieldYear =
    typeof yearField === 'number' && Number.isInteger(yearField) ? yearField : null;
  let needsReview = digitGroupSep || hasDoubledOrg(light);

  // Dash-year rule: trailing -YYYY or /YYYY (optional -MM) matching
  // the year field becomes :YYYY (month dropped). -YY only when it
  // matches the field year's last two digits and no other "-" comes
  // before it. A disagreeing 4-digit dash segment stays literal and
  // flags a year conflict.
  if (!COLON_YEAR_RE.test(light) && !isAmendment && fieldYear !== null) {
    const dashYear = DASH_YEAR_RE.exec(light);
    if (dashYear && Number(dashYear[1]) === fieldYear) {
      light = `${light.slice(0, dashYear.index)}:${dashYear[1]}`;
    } else if (dashYear) {
      needsReview = true;
    } else {
      const dashYY = DASH_YY_RE.exec(light);
      if (
        dashYY &&
        Number(dashYY[1]) === fieldYear % 100 &&
        !light.slice(0, dashYY.index).includes('-')
      ) {
        light = `${light.slice(0, dashYY.index)}:${fieldYear}`;
      }
    }
  }

  const yearSeg = COLON_YEAR_RE.exec(light);
  if (yearSeg) {
    const codeYear = Number(yearSeg[1]);
    return {
      normalized_code: light,
      base_key: light.slice(0, yearSeg.index),
      year: codeYear,
      is_amendment: isAmendment,
      needs_review:
        needsReview ||
        (fieldYear !== null && fieldYear !== codeYear) ||
        !yearInRange(codeYear)
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
      needs_review: needsReview || !yearInRange(fieldYear)
    };
  }

  return {
    normalized_code: light,
    base_key: light,
    year: null,
    is_amendment: isAmendment,
    needs_review: needsReview
  };
}

/** FDIS drafts sort below the official edition in lookup results. */
export function isFdisCode(normalizedCode: string): boolean {
  return normalizedCode.includes('FDIS');
}
