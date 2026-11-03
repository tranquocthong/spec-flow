/**
 * trace-build reads the §13.2 `Level` column (test-level-discipline FR-006/007/008/019).
 *
 * Every case runs the real CLI in a throwaway temp project and reads the
 * resulting trace.json, mirroring test/flow-tools.test.cjs.
 *
 * Run:  node --test test/level-trace.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');

function run(args, cwd) {
  let out;
  try {
    out = execFileSync('node', [ENGINE, ...args], { cwd, encoding: 'utf8' });
  } catch (e) {
    if (e.stdout) out = String(e.stdout);
    else throw e;
  }
  return JSON.parse(out.trim().split('\n').pop());
}

/** Build an SD in a temp project from §13.2 header + rows; return { r, nodes }. */
function build(header, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-level-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true, 'init-project ok');
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  const sep = header.split('|').slice(1, -1).map(() => ' --- ').join('|');
  fs.writeFileSync(path.join(sdDir, 'SD.md'), [
    '# SD: demo',
    '',
    '## 5.1 Functional Requirements',
    '',
    '| FR ID | Requirement | Priority | Source |',
    '| --- | --- | --- | --- |',
    '| FR-001 | Do a thing | Must Have | US-1 |',
    '',
    '## 13.2 Test Cases',
    '',
    header,
    `|${sep}|`,
    ...rows,
    '',
  ].join('\n'));
  const r = run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir);
  assert.equal(r.ok, true, 'trace-build ok');
  const trace = JSON.parse(fs.readFileSync(path.join(dir, '.spec-flow', 'trace.json'), 'utf8'));
  return { r, nodes: trace.nodes.tc };
}

const H6 = '| TC ID | Flow | Test Case | Input / Condition | Expected Result | Level |';
const levelWarnings = (r) => r.data.warnings.filter(w => /^TC_LEVEL_/.test(w));

test('TC-002: Level column is stored on TC nodes, normalized to lowercase', () => {
  const { r, nodes } = build(H6, [
    '| TC-001 | f | a | in | out | unit |',
    '| TC-002 | f | b | in | out | IT |',
    '| TC-003 | f | c | in | out | live |',
  ]);
  assert.deepEqual(nodes.map(n => n.level), ['unit', 'it', 'live']);
  assert.deepEqual(levelWarnings(r), []);
});

test('TC-003: empty Level cell warns TC_LEVEL_MISSING and defaults to unit', () => {
  const { r, nodes } = build(H6, [
    '| TC-001 | f | a | in | out |  |',
    '| TC-002 | f | b | in | out | it |',
    '| TC-003 | f | c | in | out |  |',
  ]);
  assert.deepEqual(levelWarnings(r), ['TC_LEVEL_MISSING: TC-001, TC-003']);
  assert.deepEqual(nodes.map(n => n.level), ['unit', 'it', 'unit']);
});

test('TC-004: unknown Level warns TC_LEVEL_INVALID with the written value and defaults to unit', () => {
  const { r, nodes } = build(H6, [
    '| TC-001 | f | a | in | out | integration |',
    '| TC-002 | f | b | in | out | Smoke |',
  ]);
  assert.deepEqual(levelWarnings(r), ['TC_LEVEL_INVALID: TC-001=integration', 'TC_LEVEL_INVALID: TC-002=Smoke']);
  assert.deepEqual(nodes.map(n => n.level), ['unit', 'unit']);
});

test('TC-014 (trace-build): SD without a Level column emits no warning and no level field', () => {
  const { r, nodes } = build('| TC ID | Flow | Test Case | Input / Condition | Expected Result |', [
    '| TC-001 | f | a | in | out |',
  ]);
  assert.deepEqual(levelWarnings(r), []);
  assert.equal(nodes.length, 1);
  assert.equal('level' in nodes[0], false, 'no level key on the node');
});

test('parseTcLevels helper: reusable, returns { hasLevel, levels, warnings }', () => {
  const { parseTcLevels } = require('../lib/trace.cjs');
  const table = {
    headers: ['TC ID', 'Flow', 'Level'],
    rows: [['TC-001', 'f', 'IT'], ['TC-002', 'f', ''], ['TC-003', 'f', 'x']],
  };
  const out = parseTcLevels(table, 0);
  assert.equal(out.hasLevel, true);
  assert.deepEqual(out.levels, { 'TC-001': 'it', 'TC-002': 'unit', 'TC-003': 'unit' });
  assert.deepEqual(out.warnings, ['TC_LEVEL_MISSING: TC-002', 'TC_LEVEL_INVALID: TC-003=x']);
  assert.equal(parseTcLevels({ headers: ['TC ID', 'Flow'], rows: [['TC-001', 'f']] }, 0).hasLevel, false);
  assert.equal(parseTcLevels(null, 0).hasLevel, false);
});
