/**
 * Unit tests for the test-level-discipline doctor checks (FR-010, FR-018):
 *   - testing.itBudget   must be null or a positive integer  -> WARN_ITBUDGET_INVALID
 *   - verify.closeoutSuite must be "local" or "ci"           -> WARN_CLOSEOUTSUITE_INVALID
 * Absent keys and valid values must produce no warning.
 *
 * Run:  node --test test/level-doctor.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const maintenance = require('../lib/maintenance.cjs');

/** Run doctor in a fresh temp project whose config has `patch` merged in (one level deep). */
function doctorWith(patch) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-level-doctor-'));
  try {
    process.chdir(dir);
    maintenance['init-project']({ stack: 'node' });
    const cfgPath = '.spec-flow/config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const [k, v] of Object.entries(patch || {})) {
      cfg[k] = (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object')
        ? Object.assign({}, cfg[k], v)
        : v;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return maintenance.doctor({}).data.checks;
  } finally {
    process.chdir(prev);
  }
}

const withCode = (checks, code) => checks.filter(c => JSON.stringify(c).includes(code));

test('TC-012: itBudget "abc" -> WARN_ITBUDGET_INVALID', () => {
  const hits = withCode(doctorWith({ testing: { itBudget: 'abc' } }), 'WARN_ITBUDGET_INVALID');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, 'warn');
  assert.match(hits[0].detail, /testing\.itBudget/);
  assert.match(hits[0].detail, /positive integer or null/);
  assert.match(hits[0].detail, /treated as off/);
});

for (const bad of [1.5, 0, -3, '5', true, [], {}]) {
  test(`FR-010: itBudget ${JSON.stringify(bad)} -> WARN_ITBUDGET_INVALID`, () => {
    const hits = withCode(doctorWith({ testing: { itBudget: bad } }), 'WARN_ITBUDGET_INVALID');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].status, 'warn');
  });
}

for (const good of [null, 5, 1]) {
  test(`FR-010: itBudget ${JSON.stringify(good)} -> no warning`, () => {
    assert.equal(withCode(doctorWith({ testing: { itBudget: good } }), 'WARN_ITBUDGET_INVALID').length, 0);
  });
}

test('FR-010: absent itBudget -> no warning', () => {
  assert.equal(withCode(doctorWith({}), 'WARN_ITBUDGET_INVALID').length, 0);
});

test('TC-013: closeoutSuite "none" -> WARN_CLOSEOUTSUITE_INVALID', () => {
  const hits = withCode(doctorWith({ verify: { closeoutSuite: 'none' } }), 'WARN_CLOSEOUTSUITE_INVALID');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, 'warn');
  assert.match(hits[0].detail, /verify\.closeoutSuite/);
  assert.match(hits[0].detail, /"local" or "ci"/);
  assert.match(hits[0].detail, /treated as "local"/);
});

for (const bad of ['', 'LOCAL', 1, null, true]) {
  test(`FR-018: closeoutSuite ${JSON.stringify(bad)} -> WARN_CLOSEOUTSUITE_INVALID`, () => {
    const hits = withCode(doctorWith({ verify: { closeoutSuite: bad } }), 'WARN_CLOSEOUTSUITE_INVALID');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].status, 'warn');
  });
}

for (const good of ['local', 'ci']) {
  test(`FR-018: closeoutSuite "${good}" -> no warning`, () => {
    assert.equal(withCode(doctorWith({ verify: { closeoutSuite: good } }), 'WARN_CLOSEOUTSUITE_INVALID').length, 0);
  });
}

test('FR-018: absent closeoutSuite -> no warning', () => {
  assert.equal(withCode(doctorWith({}), 'WARN_CLOSEOUTSUITE_INVALID').length, 0);
});

test('both invalid at once -> both warnings, independent', () => {
  const checks = doctorWith({ testing: { itBudget: 'x' }, verify: { closeoutSuite: 'y' } });
  assert.equal(withCode(checks, 'WARN_ITBUDGET_INVALID').length, 1);
  assert.equal(withCode(checks, 'WARN_CLOSEOUTSUITE_INVALID').length, 1);
});

// ---------------------------------------------------------------------------
// WARN_TESTCOMMAND_EMPTY — an empty verify.testCommand turns the verify gate
// into a silent no-op for a whole phase; doctor names it before the phase runs.
// ---------------------------------------------------------------------------

/** Doctor in a temp dir prepared by `setup(dir)` before init, config patched after. */
function doctorIn(setup, patch, initArgs) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-level-doctor-'));
  try {
    process.chdir(dir);
    if (setup) setup(dir);
    maintenance['init-project'](initArgs || {});
    const cfgPath = '.spec-flow/config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const [k, v] of Object.entries(patch || {})) cfg[k] = Object.assign({}, cfg[k], v);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return maintenance.doctor({}).data.checks;
  } finally {
    process.chdir(prev);
  }
}

test('doctor: empty testCommand with a detectable build tool → WARN_TESTCOMMAND_EMPTY naming the command to set', () => {
  const checks = doctorIn((d) => fs.writeFileSync(path.join(d, 'go.mod'), 'module x\n'), { verify: { testCommand: null } });
  const hits = withCode(checks, 'WARN_TESTCOMMAND_EMPTY');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, 'warn');
  assert.match(hits[0].detail, /detected go/);
  assert.match(hits[0].fix, /config\.verify\.testCommand = "go test \.\/\.\.\."/);
});

test('doctor: unknown stack at init (no build file at root) → WARN_TESTCOMMAND_EMPTY with a placeholder fix', () => {
  const hits = withCode(doctorIn(null, null, {}), 'WARN_TESTCOMMAND_EMPTY');
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /<command>/);
});

test('doctor: testCommand set → no WARN_TESTCOMMAND_EMPTY', () => {
  assert.equal(withCode(doctorWith({}), 'WARN_TESTCOMMAND_EMPTY').length, 0);
});

test('doctor: multi-repo — a repo with no effective testCommand is named, a repo with an override is not', () => {
  const checks = doctorIn((d) => {
    for (const r of ['svc-a', 'svc-b']) {
      fs.mkdirSync(path.join(d, r, '.git'), { recursive: true });
    }
    fs.writeFileSync(path.join(d, 'svc-a', 'go.mod'), 'module a\n');
  }, { repos: { 'svc-b': { path: 'svc-b', verify: { testCommand: 'make test' } } } }, { repos: 'svc-a=svc-a,svc-b=svc-b' });
  // Init found no build file at the hub root → top-level testCommand is null.
  const hits = withCode(checks, 'WARN_TESTCOMMAND_EMPTY');
  assert.equal(hits.length, 1, 'only svc-a inherits the empty top-level testCommand');
  assert.match(hits[0].detail, /config\.repos\["svc-a"\].*detected go/);
  assert.match(hits[0].fix, /config\.repos\["svc-a"\] = \{ "path": "svc-a", "verify": \{ "testCommand": "go test \.\/\.\.\." \} \}/);
});

test('doctor: polyglot root (go.mod + package.json) ranks the stack config.stack names first and lists the other', () => {
  const polyglot = (d) => {
    fs.writeFileSync(path.join(d, 'go.mod'), 'module x\n');
    fs.writeFileSync(path.join(d, 'package.json'), '{}\n');
  };
  // Field case: config.stack is a free-form label naming Go first.
  const named = withCode(doctorIn(polyglot, { verify: { testCommand: null } }, {}), 'WARN_TESTCOMMAND_EMPTY');
  assert.equal(named.length, 1);
  assert.match(named[0].detail, /detected node \+ go/);
  assert.match(named[0].fix, /go: "go test \.\/\.\.\."/, 'no hint → node first, go still listed');

  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-level-doctor-'));
  try {
    process.chdir(dir);
    polyglot(dir);
    maintenance['init-project']({});
    const cfg = JSON.parse(fs.readFileSync('.spec-flow/config.json', 'utf8'));
    cfg.verify.testCommand = null;
    cfg.stack = 'go-connectrpc+nextjs+react-native';
    fs.writeFileSync('.spec-flow/config.json', JSON.stringify(cfg));
    const hits = withCode(maintenance.doctor({}).data.checks, 'WARN_TESTCOMMAND_EMPTY');
    assert.match(hits[0].fix, /config\.verify\.testCommand = "go test \.\/\.\.\."/, 'the stack config.stack names comes first');
    assert.match(hits[0].fix, /node: "npm test"/);
  } finally {
    process.chdir(prev);
  }
});
