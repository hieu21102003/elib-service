// Generate code-normalize-shared.json — the shared normalization fixture
// (input -> normalized_code / base_key) tested in BOTH elib and
// Reverse_proxy. Inputs are taken from code-parser-golden.json (generated
// from the Python original); the keys are computed by the TypeScript
// parser (buildNormalizedCode / buildBaseKey), because elib is the source
// of truth for normalized_code (plan 4.1, user decision 2026-11-23:
// built from org_prefix, each designation a separate record).
//
// Usage: npx tsx tests/fixtures/generate-shared.ts
// Do NOT hand-edit the generated JSON; regenerate instead.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseStandardCode,
  buildNormalizedCode,
  buildBaseKey
} from '../../src/standards/code-parser.js';

interface GoldenCase {
  input: string;
  expected: Record<string, unknown>;
}

const here = new URL('.', import.meta.url);
const golden = JSON.parse(
  readFileSync(new URL('./code-parser-golden.json', here), 'utf8')
) as GoldenCase[];

const shared: Array<{ input: string; normalized: string; base_key: string }> = [];
for (const { input } of golden) {
  const parsed = parseStandardCode(input);
  const normalized = buildNormalizedCode(parsed);
  const baseKey = buildBaseKey(parsed);
  if (normalized !== null && baseKey !== null) {
    shared.push({ input, normalized, base_key: baseKey });
  }
}

writeFileSync(
  new URL('./code-normalize-shared.json', here),
  JSON.stringify(shared, null, 2) + '\n',
  'utf8'
);
console.log(`shared: ${shared.length} cases`);
