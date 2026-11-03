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
