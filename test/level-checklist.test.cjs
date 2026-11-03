/**
 * checklist-gen tags Level `it` TCs as no-verify (test-level-discipline FR-011, FR-019).
 *
 * Every case runs the real CLI in a throwaway temp project, mirroring
 * test/level-budget.test.cjs.
 *
 * Run:  node --test test/level-checklist.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');
const LINT = path.join(__dirname, '..', 'skills', 'manual-test', 'scripts', 'lint-checklist.sh');

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
const COMMENT = '# proven by IT (Level: it) — retag regression to also check it live';

/** Build an SD in a temp project, run checklist-gen, return { dir, sd, out, yaml }. */
function gen(header, rows, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cl-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true, 'init-project ok');
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
  const out = path.join(dir, 'CHECKLIST.yaml');
  const cg = run(['checklist-gen', '--sd', sd, '--feature', 'demo', '--auth', 'bearer', '--type', 'api', '--out', out, ...extraArgs], dir);
  assert.equal(cg.ok, true, JSON.stringify(cg));
  return { dir, sd, out, cg, yaml: fs.readFileSync(out, 'utf8') };
}

/** Return the YAML lines of one test block (from `- id: <tc>` up to the next `- id:`). */
function block(yaml, tcId) {
  const lines = yaml.split('\n');
  const start = lines.findIndex(l => new RegExp(`^\\s*-\\s*id:\\s*${tcId}\\s*$`).test(l));
  assert.ok(start >= 0, `block ${tcId} present`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('TC-006: an it TC is emitted as tags: [no-verify] with the exact comment and no TODO stub', () => {
  const { yaml } = gen(H6, ['| TC-001 | f | a | in | out | it |']);
  const b = block(yaml, 'TC-001');
  assert.match(b, /tags: \[no-verify\]/);
  assert.ok(b.includes(COMMENT), 'exact comment line present');
  assert.doesNotMatch(b, /_assert: TODO/);
  assert.doesNotMatch(b, /\/api\/v1\/TODO/);
  assert.doesNotMatch(b, /request:/);
  assert.doesNotMatch(b, /smoke|regression\]|live-e2e\]/);
});

test('TC-006: the Level cell is matched case-insensitively (IT)', () => {
  const { yaml } = gen(H6, ['| TC-001 | f | a | in | out | IT |']);
  assert.match(block(yaml, 'TC-001'), /tags: \[no-verify\]/);
});

test('TC-007: unit and slice TCs generate as before, no no-verify anywhere', () => {
  const { yaml } = gen(H6, [
    '| TC-001 | f | a | in | out | unit |',
    '| TC-002 | f | b | in | out | slice |',
  ]);
  assert.doesNotMatch(yaml, /tags: \[[^\]]*no-verify/);
  assert.match(block(yaml, 'TC-001'), /tags: \[smoke\]/);
  assert.match(block(yaml, 'TC-002'), /tags: \[regression\]/);
  assert.match(block(yaml, 'TC-001'), /_assert: TODO/);
  assert.match(yaml, /tags: \[smoke, regression\]/);
});

test('TC-014 (checklist half): SD without a Level column generates the legacy output, no no-verify', () => {
  const { yaml, cg } = gen(H5, [
    '| TC-001 | f | a | in | out |',
    '| TC-002 | f | b | in | out |',
    '| TC-003 | g | Edge: c | in | out |',
  ]);
  assert.doesNotMatch(yaml, /tags: \[[^\]]*no-verify/);
  assert.doesNotMatch(yaml, /proven by IT/);
  assert.match(block(yaml, 'TC-001'), /tags: \[smoke\]/);
  assert.match(block(yaml, 'TC-002'), /tags: \[regression\]/);
  assert.match(block(yaml, 'TC-003'), /tags: \[regression\]/);
  assert.deepEqual(cg.data.warnings.filter(w => /LEVEL/.test(w)), []);
});

test('smoke spine: an it TC never takes the smoke slot, the first non-it non-edge TC does', () => {
  const { yaml } = gen(H6, [
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | unit |',
    '| TC-003 | f | c | in | out | unit |',
  ]);
  assert.match(block(yaml, 'TC-001'), /tags: \[no-verify\]/);
  assert.match(block(yaml, 'TC-002'), /tags: \[smoke\]/);
  assert.match(block(yaml, 'TC-003'), /tags: \[regression\]/);
  assert.equal((yaml.match(/tags: \[smoke\]/g) || []).length, 1);
});

test('smoke spine: a flow whose TCs are all it has no smoke test; suite tags stay consistent', () => {
  const { yaml } = gen(H6, [
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | it |',
  ]);
  assert.doesNotMatch(yaml, /\[smoke/);
  assert.doesNotMatch(yaml, /tags: \[[^\]]*regression/);
  const suiteTags = yaml.match(/^    tags: \[(.*)\]$/m);
  assert.ok(suiteTags, 'suite tags line present');
  assert.equal(suiteTags[1], 'no-verify');
});

test('suite tags list only what the suite really contains (it + unit)', () => {
  const { yaml } = gen(H6, [
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | unit |',
  ]);
  const suiteTags = yaml.match(/^    tags: \[(.*)\]$/m);
  assert.equal(suiteTags[1], 'smoke');
});

test('live-level TC is emitted exactly like an unleveled TC', () => {
  const live = gen(H6, ['| TC-001 | f | a | in | out | live |', '| TC-002 | f | b | in | out | live |']);
  const plain = gen(H5, ['| TC-001 | f | a | in | out |', '| TC-002 | f | b | in | out |']);
  assert.doesNotMatch(live.yaml, /tags: \[[^\]]*no-verify/);
  assert.equal(block(live.yaml, 'TC-001'), block(plain.yaml, 'TC-001'));
  assert.equal(block(live.yaml, 'TC-002'), block(plain.yaml, 'TC-002'));
});

test('no-HTTP (live-e2e shape): an it TC is no-verify, without the live-e2e tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cl-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  const sd = path.join(sdDir, 'SD.md');
  fs.writeFileSync(sd, [
    '# SD: demo',
    '',
    '## 13.2 Test Cases',
    '',
    H6,
    '| --- | --- | --- | --- | --- | --- |',
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | unit |',
    '',
  ].join('\n'));
  const out = path.join(dir, 'CHECKLIST.yaml');
  const cg = run(['checklist-gen', '--sd', sd, '--feature', 'demo', '--auth', 'bearer', '--type', 'library', '--out', out], dir);
  assert.equal(cg.ok, true, JSON.stringify(cg));
  const yaml = fs.readFileSync(out, 'utf8');
  const b1 = block(yaml, 'TC-001');
  assert.match(b1, /tags: \[no-verify\]/);
  assert.ok(b1.includes(COMMENT));
  assert.doesNotMatch(b1, /live-e2e/);
  const b2 = block(yaml, 'TC-002');
  assert.match(b2, /tags: \[smoke, live-e2e\]/);
});

test('checklist-status reports the it TC as no-verify and the unit TC as scaffold', () => {
  const { dir, out } = gen(H6, [
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | unit |',
  ]);
  const st = run(['checklist-status', '--file', out, '--feature', 'demo'], dir);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.deepEqual(st.data.byStatus['no-verify'], ['TC-001']);
  assert.deepEqual(st.data.byStatus.scaffold, ['TC-002']);
});

test('an all-it checklist is ready in checklist-status and passes lint-checklist', (t) => {
  const { dir, out } = gen(H6, [
    '| TC-001 | f | a | in | out | it |',
    '| TC-002 | f | b | in | out | it |',
  ]);
  const st = run(['checklist-status', '--file', out, '--feature', 'demo'], dir);
  assert.deepEqual(st.data.byStatus['no-verify'], ['TC-001', 'TC-002']);
  assert.equal(st.data.ready, true);
  const py = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (py.status !== 0) return t.skip('PyYAML not installed');
  const lint = spawnSync('bash', [LINT, out], { cwd: dir, encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});
