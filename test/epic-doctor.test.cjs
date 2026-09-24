/**
 * Tests for FR-029..FR-032: doctor WARN checks for epic workspace files.
 * TC-023: legacy .md epic warns
 * TC-024: EPIC.md sub-feature missing specs/ warns
 * TC-025: stale reverse EPIC link warns
 * TC-026: sensitive file not git-ignored warns
 * TC-027: sensitive file that IS git-ignored does NOT warn
 * TC-028: git-not-found → graceful skip (verified by code inspection / no FAIL status)
 *
 * Run: node test/epic-doctor.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');

/** Run the engine; return the parsed Result even when it exits non-zero. */
function run(args, cwd) {
  let out;
  try {
    out = execFileSync('node', [ENGINE, ...args], { cwd, encoding: 'utf8' });
  } catch (e) {
    if (e.stdout) out = String(e.stdout);
    else throw e;
  }
  const lastLine = out.trim().split('\n').pop();
  return JSON.parse(lastLine);
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-edr-'));
  return dir;
}

function initProject(dir) {
  const r = run(['init-project', '--stack', 'node'], dir);
  assert.equal(r.ok, true, 'init-project should succeed');
  return r;
}

/** Create a real git repo with one commit on `main` under root/name; return its path. */
function makeGitRepo(root, name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: d });
  return d;
}

// ---------------------------------------------------------------------------
// TC-023: doctor warns about legacy .md epic file
// ---------------------------------------------------------------------------
test('TC-023: doctor warns about legacy single-file epic (.md)', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create the legacy .md file directly in epics/
  const epicsDir = path.join(dir, '.spec-flow', 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });
  fs.writeFileSync(path.join(epicsDir, 'old-epic.md'), '# Old Epic\n');

  const r = run(['doctor'], dir);
  assert.equal(r.ok, true);
  const checks = r.data.checks;
  const match = checks.find(c => c.name === 'epic-legacy-old-epic');
  assert.ok(match, `Expected check 'epic-legacy-old-epic' in doctor output. Got: ${JSON.stringify(checks.map(c => c.name))}`);
  assert.equal(match.status, 'warn');
});

// ---------------------------------------------------------------------------
// TC-024: doctor warns about EPIC.md sub-feature missing specs/
// ---------------------------------------------------------------------------
test('TC-024: doctor warns stale sub-feature listing in EPIC.md', () => {
  const dir = tmpProject();
  initProject(dir);

  const epicDir = path.join(dir, '.spec-flow', 'epics', 'myepic');
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicDir, 'EPIC.md'),
    '# My Epic\n\n## Sub-features\n- feat-missing\n'
  );
  // Do NOT create .spec-flow/specs/feat-missing/

  const r = run(['doctor'], dir);
  assert.equal(r.ok, true);
  const checks = r.data.checks;
  const match = checks.find(c => c.name === 'epic-stale-listing:myepic/feat-missing');
  assert.ok(match, `Expected 'epic-stale-listing:myepic/feat-missing'. Got: ${JSON.stringify(checks.map(c => c.name))}`);
  assert.equal(match.status, 'warn');
});

// ---------------------------------------------------------------------------
// TC-025: doctor warns about stale reverse EPIC link
// ---------------------------------------------------------------------------
test('TC-025: doctor warns about stale reverse EPIC link', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create specs/feat-a/ with EPIC file pointing to ghost-epic
  const featDir = path.join(dir, '.spec-flow', 'specs', 'feat-a');
  fs.mkdirSync(featDir, { recursive: true });
  fs.writeFileSync(path.join(featDir, 'EPIC'), 'ghost-epic');
  // Do NOT create .spec-flow/epics/ghost-epic/ or .spec-flow/epics/ghost-epic.md

  const r = run(['doctor'], dir);
  assert.equal(r.ok, true);
  const checks = r.data.checks;
  const match = checks.find(c => c.name === 'epic-stale-reverse:feat-a');
  assert.ok(match, `Expected 'epic-stale-reverse:feat-a'. Got: ${JSON.stringify(checks.map(c => c.name))}`);
  assert.equal(match.status, 'warn');
});

// ---------------------------------------------------------------------------
// TC-026: doctor warns about sensitive file not git-ignored
// ---------------------------------------------------------------------------
test('TC-026: doctor warns about sensitive file in epics/ that is not git-ignored', () => {
  const root = os.tmpdir();
  const repoDir = makeGitRepo(root, 'sf-edr-repo-' + Date.now());
  initProject(repoDir);

  const epicDir = path.join(repoDir, '.spec-flow', 'epics', 'myepic');
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'EPIC.md'), '# My Epic\n');
  fs.writeFileSync(path.join(epicDir, 'private_key.md'), 'secret content');
  // Override any global gitignore that might ignore .spec-flow/ — the negation
  // ensures git check-ignore treats files in .spec-flow/epics/ as NOT globally ignored,
  // so the doctor check fires for this non-specifically-ignored sensitive file.
  fs.writeFileSync(path.join(repoDir, '.gitignore'), '!.spec-flow/\n!.spec-flow/**\n');

  const r = run(['doctor'], repoDir);
  assert.equal(r.ok, true);
  const checks = r.data.checks;
  const secretChecks = checks.filter(c => c.name.startsWith('epic-secret'));
  assert.ok(
    secretChecks.some(c => c.status === 'warn' && c.name.includes('private_key')),
    `Expected a warn for private_key.md. Got epic-secret checks: ${JSON.stringify(secretChecks)}`
  );
});

// ---------------------------------------------------------------------------
// TC-027: no warn when sensitive file is git-ignored
// ---------------------------------------------------------------------------
test('TC-027: no warn when sensitive file in epics/ is git-ignored', () => {
  const root = os.tmpdir();
  const repoDir = makeGitRepo(root, 'sf-edr-repo-ign-' + Date.now());
  initProject(repoDir);

  const epicDir = path.join(repoDir, '.spec-flow', 'epics', 'myepic');
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'EPIC.md'), '# My Epic\n');
  fs.writeFileSync(path.join(epicDir, 'private_key.md'), 'secret content');
  // Un-ignore .spec-flow/ globally, then explicitly ignore the specific file —
  // this self-contained setup works regardless of any global gitignore on the machine.
  fs.writeFileSync(
    path.join(repoDir, '.gitignore'),
    '!.spec-flow/\n!.spec-flow/**\n.spec-flow/epics/myepic/private_key.md\n'
  );

  const r = run(['doctor'], repoDir);
  assert.equal(r.ok, true);
  const checks = r.data.checks;
  const secretWarn = checks.find(c => c.name.startsWith('epic-secret') && c.name.includes('private_key'));
  assert.ok(
    !secretWarn,
    `Expected NO warn for git-ignored private_key.md but got: ${JSON.stringify(secretWarn)}`
  );
});

// ---------------------------------------------------------------------------
// TC-028: git not found → secret check skipped gracefully (no 'fail' status for epic-secret-check)
// Verified by code inspection: spawnSync ENOENT → push('epic-secret-check', 'warn', ...) only.
// The test below confirms the doctor result never has status='fail' for epic-secret-check.
// ---------------------------------------------------------------------------
test('TC-028: epic-secret-check is never status=fail (graceful skip when git unavailable)', () => {
  const dir = tmpProject();
  initProject(dir);

  const r = run(['doctor'], dir);
  assert.equal(r.ok, true);
  const secretFailCheck = r.data.checks.find(c => c.name === 'epic-secret-check' && c.status === 'fail');
  assert.ok(!secretFailCheck, 'epic-secret-check must never have status=fail (must be warn only)');
});
