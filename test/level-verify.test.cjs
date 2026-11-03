/**
 * verify.closeoutSuite: "ci" (test-level-discipline FR-015/FR-016/FR-017).
 *
 * Every case runs the real CLI in a throwaway temp project. testCommand is a
 * command that FAILS loudly, so a "delegated" run is provably not executing it.
 *
 * Run:  node --test test/level-verify.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');
const FAILING_TESTS = 'node -e "process.exit(1)"';

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

/** Temp project whose verify block has a failing testCommand; `closeoutSuite` undefined = absent. */
function project(closeoutSuite, verifyExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-closeout-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true, 'init-project ok');
  const cfgPath = path.join(dir, '.spec-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.verify = {
    testCommand: FAILING_TESTS, coverageThreshold: null, forbiddenPatterns: [], secretScan: true,
    ...verifyExtra,
  };
  if (closeoutSuite !== undefined) cfg.verify.closeoutSuite = closeoutSuite;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return dir;
}

const testsCheck = (r) => r.data.checks.find((c) => c.name === 'tests');

test('TC-009: ci + full mode never runs the failing test command; tests delegated, gate pass', () => {
  const dir = project('ci');
  const r = run(['verify-code'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(
    { name: testsCheck(r).name, status: testsCheck(r).status, detail: testsCheck(r).detail },
    { name: 'tests', status: 'delegated', detail: 'full suite delegated to CI' },
  );
  assert.equal(r.data.gate, 'pass', 'delegated is not a failure and not a no-op gate');
  assert.equal(r.data.summary.fail, 0);
  assert.equal(r.data.checks.find((c) => c.name === 'secret-scan').status, 'ok', 'static checks still run');
});

test('ci + full mode: a static check failure still fails the gate', () => {
  const dir = project('ci', { forbiddenPatterns: ['FORBIDDEN_TOKEN'] });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'this has FORBIDDEN_TOKEN in it\n');
  const r = run(['verify-code'], dir);
  assert.equal(testsCheck(r).status, 'delegated');
  assert.equal(r.data.checks.find((c) => c.name === 'forbidden-patterns').status, 'fail');
  assert.equal(r.data.gate, 'fail');
});

test('ci + full mode: when nothing else ran, gate is skipped (delegated is not local evidence)', () => {
  const dir = project('ci', { secretScan: false });
  const r = run(['verify-code'], dir);
  assert.equal(testsCheck(r).status, 'delegated');
  assert.equal(r.data.gate, 'skipped');
});

test('TC-010: ci + --task still executes the test command (scoped run ignores closeoutSuite)', () => {
  const dir = project('ci');
  const r = run(['verify-code', '--task', '1'], dir);
  assert.equal(testsCheck(r).status, 'fail', 'failing testCommand was really executed');
  assert.equal(r.data.gate, 'fail');
});

test('ci + --files still executes the test command', () => {
  const dir = project('ci');
  const r = run(['verify-code', '--files', 'src/x.js'], dir);
  assert.equal(testsCheck(r).status, 'fail');
  assert.equal(r.data.gate, 'fail');
});

for (const [label, value] of [['local', 'local'], ['absent', undefined], ['invalid', 'none']]) {
  test(`closeoutSuite ${label} + full mode: test command is executed as before`, () => {
    const dir = project(value);
    const r = run(['verify-code'], dir);
    assert.equal(testsCheck(r).status, 'fail');
    assert.equal(r.data.gate, 'fail');
  });
}

const resultsFile = (dir) => {
  const f = path.join(dir, 'results.json');
  fs.writeFileSync(f, JSON.stringify({ passed: ['TC-001'], failed: [] }));
  return f;
};
const verificationOf = (dir) =>
  fs.readFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'VERIFICATION.md'), 'utf8');

test('TC-011: verify-collect writes the delegated line before truths when ci', () => {
  const dir = project('ci');
  const r = run(['verify-collect', '--results', resultsFile(dir), '--feature', 'demo'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'passed', 'checklist regression gate unchanged');
  const md = verificationOf(dir);
  assert.ok(md.includes('Full test suite: delegated to CI'));
  assert.ok(md.indexOf('Full test suite: delegated to CI') < md.indexOf('### truths'));
  assert.match(md, /- TC-001: verified/);
});

test('verify-collect: local / absent closeoutSuite writes no delegated line', () => {
  for (const value of ['local', undefined]) {
    const dir = project(value);
    assert.equal(run(['verify-collect', '--results', resultsFile(dir), '--feature', 'demo'], dir).ok, true);
    assert.ok(!verificationOf(dir).includes('Full test suite: delegated to CI'));
  }
});
