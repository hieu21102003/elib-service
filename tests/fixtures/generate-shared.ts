// Generate code-normalize-shared.json — the shared LIGHT-normalization
// fixture (input + year_field -> normalized_code / base_key / year /
// is_amendment / needs_review) tested in BOTH elib and Reverse_proxy.
//
// Inputs come from code-parser-golden.json (generated from the Python
// original); year_field simulates the upstream `year` field and is
// taken from the golden `std_year`. Outputs are computed by
// lightNormalizeCode (src/standards/light-normalize.ts) — elib is the
// source of truth for normalized_code (user decision 2026-11-23:
// light normalization on the upstream code, full parser best-effort
// only). Un-normalizable inputs are kept with null outputs so both
// repos test the null path too.
//
// Usage: npx tsx tests/fixtures/generate-shared.ts
// Do NOT hand-edit the generated JSON; regenerate instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { lightNormalizeCode } from '../../src/standards/light-normalize.js';

interface GoldenCase {
  input: string;
  expected: Record<string, unknown>;
}

const here = new URL('.', import.meta.url);
const golden = JSON.parse(
  readFileSync(new URL('./code-parser-golden.json', here), 'utf8')
) as GoldenCase[];

const shared = golden.map(({ input, expected }) => {
  const yearField =
    typeof expected['std_year'] === 'number' ? (expected['std_year'] as number) : null;
  const light = lightNormalizeCode(input, yearField);
  return {
    input,
    year_field: yearField,
    normalized_code: light?.normalized_code ?? null,
    base_key: light?.base_key ?? null,
    year: light?.year ?? null,
    amendment_year: light?.amendment_year ?? null,
    is_amendment: light?.is_amendment ?? null,
    is_draft: light?.is_draft ?? null,
    needs_review: light?.needs_review ?? null,
    skipped_reason: light?.skipped_reason ?? null
  };
});

writeFileSync(
  new URL('./code-normalize-shared.json', here),
  JSON.stringify(shared, null, 2) + '\n',
  'utf8'
);
console.log(`shared: ${shared.length} cases`);
