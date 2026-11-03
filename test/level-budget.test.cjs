/**
 * IT budget warning in trace-build and checklist-gen (test-level-discipline FR-009, FR-019).
 *
 * Every case runs the real CLI in a throwaway temp project, mirroring
 * test/level-trace.test.cjs.
 *
 * Run:  node --test test/level-budget.test.cjs
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

const H6 = '| TC ID | Flow | Test Case | Input / Condition | Expected Result | Level |';
const H5 = '| TC ID | Flow | Test Case | Input / Condition | Expected Result |';
const IT3 = [
  '| TC-001 | f | a | in | out | it |',
  '| TC-002 | f | b | in | out | IT |',
  '| TC-003 | f | c | in | out | it |',
  '| TC-004 | f | d | in | out | unit |',
];
const NO_LEVEL = [
  '| TC-001 | f | a | in | out |',
  '| TC-002 | f | b | in | out |',
  '| TC-003 | f | c | in | out |',
];

/**
 * Build an SD in a temp project, optionally set testing.itBudget (omit the key
 * when `budget` is undefined), then run both commands. Returns their warnings.
 */
function both(header, rows, budget) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-budget-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true, 'init-project ok');
  if (budget !== undefined) {
    const cfgPath = path.join(dir, '.spec-flow', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.testing = { itBudget: budget };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  const sep = header.split('|').slice(1, -1).map(() => ' --- ').join('|');
  const sd = path.join(sdDir, 'SD.md');
  fs.writeFileSync(sd, [
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
  const tb = run(['trace-build', '--sd', sd, '--feature', 'demo'], dir);
  const cg = run(['checklist-gen', '--sd', sd, '--feature', 'demo', '--auth', 'bearer', '--dry-run'], dir);
  return { tb, cg };
}

const budgetWarnings = (r) => r.data.warnings.filter(w => /^IT_BUDGET_EXCEEDED/.test(w));

test('TC-005: trace-build warns IT_BUDGET_EXCEEDED when it count exceeds itBudget, without blocking', () => {
  const { tb } = both(H6, IT3, 2);
  assert.equal(tb.ok, true);
  assert.deepEqual(budgetWarnings(tb), ['IT_BUDGET_EXCEEDED: 3 TC(s) at Level it, budget 2']);
});

test('TC-008: checklist-gen warns IT_BUDGET_EXCEEDED when it count exceeds itBudget, without blocking', () => {
  const { cg } = both(H6, IT3, 2);
  assert.equal(cg.ok, true);
  assert.deepEqual(budgetWarnings(cg), ['IT_BUDGET_EXCEEDED: 3 TC(s) at Level it, budget 2']);
});

test('no warning when the it count equals the budget', () => {
  const { tb, cg } = both(H6, IT3, 3);
  assert.deepEqual(budgetWarnings(tb), []);
  assert.deepEqual(budgetWarnings(cg), []);
});

for (const [label, budget] of [['string', 'abc'], ['float', 1.5], ['zero', 0], ['negative', -1], ['null', null], ['absent', undefined]]) {
  test(`invalid or disabled itBudget (${label}) disables the budget check in both commands`, () => {
    const { tb, cg } = both(H6, IT3, budget);
    assert.equal(tb.ok, true);
    assert.equal(cg.ok, true);
    assert.deepEqual(budgetWarnings(tb), []);
    assert.deepEqual(budgetWarnings(cg), []);
  });
}

test('TC-014 (budget half): SD without a Level column counts nothing even with itBudget 1', () => {
  const { tb, cg } = both(H5, NO_LEVEL, 1);
  assert.equal(tb.ok, true);
  assert.equal(cg.ok, true);
  assert.deepEqual(budgetWarnings(tb), []);
  assert.deepEqual(budgetWarnings(cg), []);
});
