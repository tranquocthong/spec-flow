'use strict';
// SD template §13.1 (test-level policy) and §13.2 (Level column) contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'templates', 'sd-template.md'), 'utf8');

function section(startRe, endRe) {
  const start = TEMPLATE.search(startRe);
  assert.ok(start >= 0, `section start not found: ${startRe}`);
  const nl = TEMPLATE.indexOf('\n', start);
  const rest = TEMPLATE.slice(nl + 1);
  const end = rest.search(endRe);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const s131 = () => section(/^### 13\.1 /m, /^(### |## )/m);
const s132 = () => section(/^### 13\.2 /m, /^(### |## )/m);

test('level-template: §13.1 defines all four levels (unit, slice, it, live)', () => {
  const text = s131();
  for (const level of ['unit', 'slice', 'it', 'live']) {
    assert.match(text, new RegExp('`' + level + '`'), `level \`${level}\` not defined in §13.1`);
  }
  assert.match(text, /cheapest level/i, 'principle "cheapest level that can prove it" missing');
});

test('level-template: §13.1 no longer carries the old coverage table', () => {
  const text = s131();
  assert.doesNotMatch(text, /Integration Tests/);
  assert.doesNotMatch(text, /Critical paths/);
  assert.doesNotMatch(text, /Coverage Target/);
});

test('level-template: §13.1 names no framework or tool', () => {
  assert.doesNotMatch(s131(), /spring|junit|jest|pytest|mockito|webflux|flyway|testcontainers/i);
});

test('level-template: §13.2 TC table header has a Level column (last)', () => {
  const text = s132();
  const header = text.split('\n').find((l) => /^\|\s*ID\s*\|/.test(l));
  assert.ok(header, '§13.2 table header not found');
  const cols = header.split('|').map((c) => c.trim()).filter(Boolean);
  assert.ok(cols.includes('Level'), 'Level column missing');
  assert.equal(cols[cols.length - 1], 'Level', 'Level must be the last column');
});

test('level-template: every §13.2 example row carries a valid Level value', () => {
  const rows = s132().split('\n').filter((l) => /^\|\s*TC-\d+/.test(l));
  assert.ok(rows.length > 0, 'no example rows');
  for (const row of rows) {
    const cols = row.split('|').map((c) => c.trim()).filter(Boolean);
    assert.match(cols[cols.length - 1], /^(unit|slice|it|live)$/, `bad Level in row: ${row}`);
  }
});
