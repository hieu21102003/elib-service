// Generate ~/workspace/standards-lookup-samples/light-normalize-table.md
// by RUNNING lightNormalizeCode over (a) the real codes extracted from
// the sample JSON files and (b) the golden sample inputs.
//
// Usage: npx tsx tests/fixtures/generate-light-normalize-table.ts
// Do NOT hand-edit the generated markdown; regenerate instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { lightNormalizeCode } from '../../src/standards/light-normalize.js';
import { splitReplacesParts } from '../../src/standards/repository.js';

const samplesDir = new URL('../../../standards-lookup-samples/', import.meta.url);
const here = new URL('.', import.meta.url);

interface Row {
  code: string;
  yearField: number | null;
  source: string;
}

const realRows: Row[] = [];
const seen = new Set<string>();
function addRow(code: unknown, yearField: unknown, source: string): void {
  if (typeof code !== 'string' || code.trim().length === 0) return;
  const year = typeof yearField === 'number' ? yearField : null;
  const key = `${code} ${year}`;
  if (seen.has(key)) return;
  seen.add(key);
  realRows.push({ code, yearField: year, source });
}

function readSample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, samplesDir), 'utf8')) as Record<string, unknown>;
}

for (const name of ['search-iso-9001.json', 'search-tcvn-9143.json']) {
  const doc = readSample(name);
  for (const item of (doc['data'] as Array<Record<string, unknown>>) ?? []) {
    addRow(item['code'], item['year'], `${String(item['source'])} (${name})`);
  }
}

for (const name of [
  'detail-iso-9001.json',
  'detail-tcvn-9143-2012.json',
  'detail-tcvn-9143-2022.json',
  'detail-vsqi-tcvn-9143-2022.json'
]) {
  const doc = readSample(name);
  const data = (doc['data'] as Record<string, unknown>) ?? doc;
  const source = String(data['source']);
  addRow(data['code'], data['year'], `${source} (${name})`);
  for (const field of ['replaces', 'replacedBy'] as const) {
    for (const part of splitReplacesParts(data[field] as string | null)) {
      addRow(part.code, part.year, `${source} ${field} (${name})`);
    }
  }
  for (const rel of (data['relations'] as Array<Record<string, unknown>>) ?? []) {
    if (typeof rel['code'] === 'string') {
      addRow(rel['code'], null, `${source} rel/${String(rel['type'])} (${name})`);
    }
  }
}

interface GoldenCase {
  input: string;
  expected: Record<string, unknown>;
}
const golden = JSON.parse(
  readFileSync(new URL('./code-parser-golden.json', here), 'utf8')
) as GoldenCase[];
const goldenRows: Row[] = golden.map(({ input, expected }) => ({
  code: input,
  yearField: typeof expected['std_year'] === 'number' ? (expected['std_year'] as number) : null,
  source: 'golden'
}));

function cell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  return String(value).replace(/\|/g, '\\|');
}

function table(rows: Row[], withSource: boolean): string {
  const header = withSource
    ? '| input code | year field | normalized_code | base_key | year | amendment_year | is_amendment | is_draft | needs_review | skipped_reason | source |\n|---|---|---|---|---|---|---|---|---|---|---|'
    : '| input code | year field | normalized_code | base_key | year | amendment_year | is_amendment | is_draft | needs_review | skipped_reason |\n|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map((row) => {
    const light = lightNormalizeCode(row.code, row.yearField);
    const base = [
      cell(row.code),
      cell(row.yearField),
      cell(light?.normalized_code ?? null),
      cell(light?.base_key ?? null),
      cell(light?.year ?? null),
      cell(light?.amendment_year ?? null),
      cell(light?.is_amendment ?? null),
      cell(light?.is_draft ?? null),
      cell(light?.needs_review ?? null),
      cell(light?.skipped_reason ?? null)
    ];
    if (withSource) base.push(cell(row.source));
    return `| ${base.join(' | ')} |`;
  });
  return [header, ...lines].join('\n');
}

const md = `# Bảng chuẩn hóa nhẹ — input → khóa gộp

Sinh tự động bằng \`tests/fixtures/generate-light-normalize-table.ts\` (chạy chính \`lightNormalizeCode\` trong \`src/standards/light-normalize.ts\`). Không sửa tay.

## (a) Mã thật từ file mẫu (${realRows.length} mã phân biệt theo code + year field)

${table(realRows, true)}

## (b) Bộ mã mẫu golden (${goldenRows.length} input, year field = std_year của parser Python)

${table(goldenRows, false)}
`;

writeFileSync(new URL('light-normalize-table.md', samplesDir), md, 'utf8');
console.log(`real: ${realRows.length}, golden: ${goldenRows.length}`);
