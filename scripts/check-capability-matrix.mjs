#!/usr/bin/env node
// Documentation/catalog consistency only; no game, socket or credentials.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('CAPABILITIES.json', root), 'utf8'));
const document = readFileSync(new URL('docs/CAPABILITY-MATRIX.md', root), 'utf8');
const rows = [...document.matchAll(/^\| `([^`]+)` \| ([^|]+) \| (catalog-only|dedicated-fixture) \| (?:`([^`]+)`|—) \|$/gm)];
const actual = catalog.tools.map(tool => tool.name).sort();
const documented = rows.map(row => row[1]).sort();
assert.deepEqual(documented, actual, 'The matrix must contain exactly one row per backend tool');
for (const row of rows) {
  assert.ok(row[2].trim().length > 0, 'Every tool needs a family');
  assert.equal(Boolean(row[4]), row[3] === 'dedicated-fixture', 'Only dedicated-fixture rows reference a test');
  if (row[4]) {
    assert.match(row[4], /^(tests|scripts)\/[A-Za-z0-9_./-]+\.(ts|mjs)$/);
    assert.ok(!row[4].split('/').includes('..'));
    assert.ok(statSync(fileURLToPath(new URL(row[4], root))).isFile(), 'Referenced fixture must exist');
  }
}
for (const forbidden of ['send_packet', 'run_command', 'connect_bot', 'reconnect_bot', 'creative_fly']) {
  assert.ok(!actual.includes(forbidden), 'Excluded runtime tools cannot be advertised');
}
console.log(JSON.stringify({ passed: true, backendVersion: catalog.server.version, documentedTools: rows.length,
  dedicatedFixtureRows: rows.filter(row => row[3] === 'dedicated-fixture').length,
  scope: 'catalog/document consistency, not execution or real-server certification' }));
