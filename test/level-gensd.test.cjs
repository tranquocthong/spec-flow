'use strict';
// FR-003: genSd Pass-1 (sd-skeleton) emits a trailing `Level` column in §13.2,
// and every placeholder TC row carries `unit` in that column.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.cjs');

function gen(md, feature) {
  return core.genSd(core.parseSrs(md), { type: 'api', feature });
}

// Returns { header: string[], sep: string, rows: string[] } for the §13.2 table.
function tcTable(sd) {
  const lines = sd.split('\n');
  const h = lines.findIndex((l) => l.startsWith('| TC ID |'));
  assert.ok(h >= 0, '§13.2 header row present');
  const rows = [];
  for (let i = h + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
  return { header: core.splitRow(lines[h]), sep: lines[h + 1], rows };
}

function assertAligned(sd) {
  const t = tcTable(sd);
  assert.equal(t.header[t.header.length - 1], 'Level', 'last header cell is Level');
  assert.equal(core.splitRow(t.sep).length, t.header.length, 'separator cell count matches header');
  assert.ok(t.rows.length > 0, 'at least one TC row');
  for (const r of t.rows) {
    const cells = core.splitRow(r);
    assert.equal(cells.length, t.header.length, `row has ${t.header.length} cells: ${r}`);
    assert.equal(cells[cells.length - 1], 'unit', `row ends with unit: ${r}`);
  }
  return t;
}

test('genSd §13.2: header carries a trailing Level column', () => {
  const { sd } = gen([
    '# Feature: lvl',
    '## 4. User Stories',
    '### US-1: a story',
    '- As a developer,',
    '#### Acceptance Criteria',
    '- the thing works',
  ].join('\n'), 'lvl');
  const t = tcTable(sd);
  assert.deepEqual(t.header, ['TC ID', 'Flow', 'Test Case', 'Expected', 'Level']);
});

test('genSd §13.2: AC and edge-case rows each end with unit and keep header cell count', () => {
  const { sd } = gen([
    '# Feature: lvl',
    '## 4. User Stories',
    '### US-1: a story',
    '- As a developer,',
    '#### Acceptance Criteria',
    '- the thing works',
    '- the other thing works',
    '#### Edge Cases',
    '- input is empty',
  ].join('\n'), 'lvl');
  const t = assertAligned(sd);
  assert.equal(t.rows.length, 3, 'two AC rows + one edge row');
});

test('genSd §13.2: rows harvested from an SRS TC table end with unit', () => {
  const { sd, stats } = gen([
    '# Feature: table-style',
    '## 5. Functional Requirements',
    '',
    '| ID | Requirement | Priority |',
    '| --- | --- | --- |',
    '| FR-1 | do a thing | Must Have |',
    '',
    '| TC ID | Test Case | Flow |',
    '| --- | --- | --- |',
    '| TC-1 | verify thing | happy |',
    '| TC-2 | verify other | happy |',
    '',
  ].join('\n'), 'table-style');
  assert.equal(stats.testCases, 2);
  const t = assertAligned(sd);
  assert.equal(t.rows.length, 2);
});

test('genSd §13.2: the EMPTY_HARVEST placeholder row also ends with unit', () => {
  const r = gen('# Feature: nothing\n\nJust prose, no tables, no stories.\n', 'nothing');
  assert.ok(r.warnings.some((w) => w.startsWith('EMPTY_HARVEST')), 'harvest was empty');
  const t = assertAligned(r.sd);
  assert.equal(t.rows.length, 1);
  assert.ok(t.rows[0].startsWith('| TC-001 |'), 'placeholder row is TC-001');
});

test('genSd §13.2: a `|` in harvested TC text does not shift the Level column', () => {
  const { sd } = gen([
    '# Feature: pipes',
    '## 5. Functional Requirements',
    '',
    '| ID | Requirement | Priority |',
    '| --- | --- | --- |',
    '| FR-1 | do a thing | Must Have |',
    '',
    '| TC ID | Test Case | Flow |',
    '| --- | --- | --- |',
    '| TC-1 | payload = a\\|b\\|c | happy |',
    '',
  ].join('\n'), 'pipes');
  assertAligned(sd);
});
