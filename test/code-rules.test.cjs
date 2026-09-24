/**
 * Unit tests for lib/code-rules.cjs — the config.verify.rules engine (SD
 * code-rules-gate §10.1, §13.2). Uses REAL temp git repos (git init, commit a
 * baseline on main, branch, modify) rather than mocking git, because the whole
 * point of this module is correct hunk/line-number parsing off actual `git diff`
 * output — a mock would just re-assert my own assumptions about the format.
 *
 * Run:  node --test test/code-rules.test.cjs   (or: node --test test/*.test.cjs)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateRules, evaluateRules } = require('../lib/code-rules.cjs');

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Init a repo on branch `main`, write `files` (relPath -> content), commit as baseline. */
function initRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-code-rules-'));
  git(['init', '-q'], dir);
  git(['checkout', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(['add', '-A'], dir);
  // --allow-empty: some fixtures intentionally start with no files at all.
  git(['commit', '-q', '--allow-empty', '-m', 'baseline'], dir);
  return dir;
}

function branch(dir, name) {
  git(['checkout', '-q', '-b', name], dir);
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commitAll(dir, msg) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', msg], dir);
}

// ---------------------------------------------------------------------------
// TC-001 / TC-002 — forbid rule, diff scope, preexisting count.
// ---------------------------------------------------------------------------

test('code-rules: forbid rule — 5 preexisting + 1 new violation on changed file (TC-001)', () => {
  const controllerLines = [
    'class FooController {',
    '  ResponseEntity<String> a() { return null; }', // preexisting 1
    '  ResponseEntity<String> b() { return null; }', // preexisting 2
    '  ResponseEntity<String> c() { return null; }', // preexisting 3
    '  ResponseEntity<String> d() { return null; }', // preexisting 4
    '  ResponseEntity<String> e() { return null; }', // preexisting 5
    '}',
  ];
  const controller = controllerLines.join('\n') + '\n';
  const dir = initRepo({ 'src/FooController.java': controller });
  branch(dir, 'feature');

  // Uncommitted change — diff vs merge-base must compare against the working
  // tree, not just committed history. Insert the new line right before the
  // closing brace (array splice, not a string .replace — every preexisting
  // line already ends with "}\n" too, at the "; }" of its method body, so a
  // naive string replace would land on the wrong line).
  const updatedLines = controllerLines.slice(0, -1)
    .concat(['  ResponseEntity<String> f() { return null; }'], controllerLines.slice(-1));
  const updated = updatedLines.join('\n') + '\n';
  writeFile(dir, 'src/FooController.java', updated);

  const rule = {
    id: 'no-response-entity',
    message: 'Use @ResponseStatus, not ResponseEntity.',
    forbid: 'ResponseEntity<',
    glob: '**/*Controller.java',
  };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.preexisting, 5, 'the 5 untouched lines are debt, not a fail');
  assert.equal(result.violations.length, 1, 'only the newly added line is a violation');
  assert.equal(result.violations[0].rule, 'no-response-entity');
  assert.equal(result.violations[0].file, 'src/FooController.java');
  assert.match(result.violations[0].text, /ResponseEntity<String> f/);
});

test('code-rules: forbid rule — task never touches the controller (TC-002)', () => {
  const controller = [
    'class FooController {',
    '  ResponseEntity<String> a() { return null; }',
    '  ResponseEntity<String> b() { return null; }',
    '  ResponseEntity<String> c() { return null; }',
    '  ResponseEntity<String> d() { return null; }',
    '  ResponseEntity<String> e() { return null; }',
    '}',
    '',
  ].join('\n');
  const dir = initRepo({ 'src/FooController.java': controller, 'README.md': '# readme\n' });
  branch(dir, 'feature');
  // Task touches something unrelated — the controller is never in the diff.
  writeFile(dir, 'README.md', '# readme\n\nupdated\n');

  const rule = {
    id: 'no-response-entity',
    message: 'Use @ResponseStatus, not ResponseEntity.',
    forbid: 'ResponseEntity<',
    glob: '**/*Controller.java',
  };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 0, 'no fail — controller was never touched');
  assert.equal(result.preexisting, 5, 'the 5 old hits are still visible as debt');
});

// ---------------------------------------------------------------------------
// TC-003 / TC-004 — when/require, file-level, new file.
// ---------------------------------------------------------------------------

test('code-rules: when/require — new file has @Scheduled but no @SchedulerLock (TC-003)', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'src/Job.java', [
    'class Job {',
    '  @Scheduled(fixedDelay = 1000)',
    '  void run() {}',
    '}',
    '',
  ].join('\n')); // untracked new file

  const rule = {
    id: 'scheduled-needs-lock',
    message: '@Scheduled must be paired with @SchedulerLock for multi-pod safety.',
    when: '@Scheduled',
    require: '@SchedulerLock',
  };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, 'src/Job.java');
  assert.equal(result.violations[0].line, 2, 'reported at the first @Scheduled line');
  assert.match(result.violations[0].text, /@Scheduled/);
});

test('code-rules: when/require — new file has both annotations (TC-004)', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'src/Job.java', [
    'class Job {',
    '  @Scheduled(fixedDelay = 1000)',
    '  @SchedulerLock(name = "job")',
    '  void run() {}',
    '}',
    '',
  ].join('\n'));

  const rule = {
    id: 'scheduled-needs-lock',
    message: '@Scheduled must be paired with @SchedulerLock for multi-pod safety.',
    when: '@Scheduled',
    require: '@SchedulerLock',
  };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 0);
});

// ---------------------------------------------------------------------------
// TC-005 — glob filters by extension/path; migration timestamptz rule.
// ---------------------------------------------------------------------------

test('code-rules: glob limits forbid to matching files only (TC-005)', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  // (a) a .java file mentioning "timestamp" — glob does not match, must not fire.
  writeFile(dir, 'src/Note.java', 'class Note { // timestamp handling here\n}\n');
  // (b) a new migration adding a bare "timestamp" column — glob matches, must fire.
  writeFile(dir, 'db/migration/V2__add_col.sql', 'ALTER TABLE foo ADD COLUMN created_at timestamp;\n');

  const rule = {
    id: 'use-timestamptz',
    message: 'Use timestamptz, not timestamp, in migrations.',
    glob: '**/migration/*.sql',
    forbid: '\\btimestamp\\b(?!\\s+with\\s+time\\s+zone)',
  };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 1, 'only the migration file is in scope for this glob');
  assert.equal(result.violations[0].file, 'db/migration/V2__add_col.sql');
});

// ---------------------------------------------------------------------------
// TC-006 — a bad regex is isolated; other rules still run; gate never throws.
// ---------------------------------------------------------------------------

test('code-rules: invalid regex on one rule does not affect other rules (TC-006)', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'src/New.java', 'class New { // TODO: fix this\n}\n');

  const rules = [
    { id: 'bad-regex', message: 'broken on purpose', forbid: '[unclosed' },
    { id: 'no-todo', message: 'no TODO markers', forbid: 'TODO' },
  ];
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules, base: 'main' });

  assert.ok(result.warnings.some((w) => w === 'RULE_INVALID_REGEX: bad-regex'));
  assert.equal(result.violations.length, 1, 'the valid rule still ran');
  assert.equal(result.violations[0].rule, 'no-todo');
});

// ---------------------------------------------------------------------------
// Untracked new file is counted (all its lines are "added").
// ---------------------------------------------------------------------------

test('code-rules: untracked new file is scanned, all lines count as added', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'src/Brand.java', 'class Brand {\n  ResponseEntity<String> x() { return null; }\n}\n');
  // Confirm it really is untracked, not staged/committed.
  const status = git(['status', '--porcelain'], dir);
  assert.match(status, /^\?\? src\/Brand\.java/m);

  const rule = { id: 'no-response-entity', message: 'no ResponseEntity', forbid: 'ResponseEntity<' };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, 'src/Brand.java');
  assert.equal(result.violations[0].line, 2);
});

// ---------------------------------------------------------------------------
// Base unavailable -> fallback to HEAD diff + warning; not a git repo at all.
// ---------------------------------------------------------------------------

test('code-rules: unresolvable base falls back to HEAD diff with a warning', () => {
  const dir = initRepo({ 'src/Keep.java': 'class Keep {}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'src/New.java', 'class New { // TODO\n}\n');

  const rule = { id: 'no-todo', message: 'no TODO markers', forbid: 'TODO' };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'does-not-exist' });

  assert.ok(result.warnings.some((w) => w.startsWith('RULE_DIFF_BASE_UNAVAILABLE')));
  // Fallback still finds the new untracked file's violation via the HEAD diff.
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, 'src/New.java');
});

test('code-rules: not a git repo — diff-scoped rules are skipped, scope:"all" still runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-code-rules-nogit-'));
  fs.writeFileSync(path.join(dir, 'Foo.java'), 'class Foo { // TODO\n}\n');

  const diffRule = { id: 'no-todo-diff', message: 'no TODO', forbid: 'TODO' }; // scope defaults to "diff"
  const allRule = { id: 'no-todo-all', message: 'no TODO', forbid: 'TODO', scope: 'all' };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [diffRule, allRule], base: 'main' });

  assert.ok(result.warnings.some((w) => w.startsWith('RULE_DIFF_BASE_UNAVAILABLE')));
  assert.equal(result.violations.length, 1, 'only the scope:"all" rule ran');
  assert.equal(result.violations[0].rule, 'no-todo-all');
});

// ---------------------------------------------------------------------------
// scope: "all" scans old, untouched code too (TC-009).
// ---------------------------------------------------------------------------

test('code-rules: scope "all" flags a violation in an untouched old file (TC-009)', () => {
  const dir = initRepo({ 'src/Old.java': 'class Old { // TODO: old debt\n}\n' });
  branch(dir, 'feature');
  writeFile(dir, 'README.md', 'unrelated change\n'); // diff exists, but not touching Old.java

  const rule = { id: 'no-todo', message: 'no TODO markers', forbid: 'TODO', scope: 'all' };
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, 'src/Old.java');
  assert.equal(result.preexisting, 0, 'scope:"all" has no preexisting concept — it is a violation outright');
});

// ---------------------------------------------------------------------------
// .md files are skipped by default (TC-015), but scanned when glob says so.
// ---------------------------------------------------------------------------

test('code-rules: .md files are skipped unless glob explicitly targets them', () => {
  const dir = initRepo({});
  branch(dir, 'feature');
  writeFile(dir, 'NOTES.md', 'TODO: write docs\n');

  const rule = { id: 'no-todo', message: 'no TODO markers', forbid: 'TODO' }; // no glob -> default excludes .md
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });
  assert.equal(result.violations.length, 0);

  const ruleMd = { id: 'no-todo-md', message: 'no TODO markers', forbid: 'TODO', glob: '**/*.md' };
  const resultMd = evaluateRules({ rootDir: dir, scanPath: '.', rules: [ruleMd], base: 'main' });
  assert.equal(resultMd.violations.length, 1);
});

// ---------------------------------------------------------------------------
// Binary / non-UTF8 files are skipped silently (TC-014).
// ---------------------------------------------------------------------------

test('code-rules: binary file is skipped, no crash, no false positive', () => {
  const dir = initRepo({});
  branch(dir, 'feature');
  const binPath = path.join(dir, 'blob.dat');
  // NUL byte + a byte sequence that would otherwise match the forbid pattern.
  fs.writeFileSync(binPath, Buffer.from([0x00, 0x54, 0x4f, 0x44, 0x4f, 0x00, 0xff]));

  const rule = { id: 'no-todo', message: 'no TODO markers', forbid: 'TODO', glob: '**/*.dat' };
  assert.doesNotThrow(() => {
    const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [rule], base: 'main' });
    assert.equal(result.violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateRules — schema errors are isolated warnings, never a throw (D4).
// ---------------------------------------------------------------------------

test('validateRules: missing id or message -> RULE_INVALID: <index>', () => {
  const { valid, warnings } = validateRules([{ message: 'no id here', forbid: 'x' }, { id: 'no-msg', forbid: 'x' }]);
  assert.equal(valid.length, 0);
  assert.ok(warnings.includes('RULE_INVALID: 0'));
  assert.ok(warnings.includes('RULE_INVALID: no-msg'));
});

test('validateRules: duplicate id -> RULE_INVALID', () => {
  const rules = [
    { id: 'dup', message: 'first', forbid: 'a' },
    { id: 'dup', message: 'second', forbid: 'b' },
  ];
  const { valid, warnings } = validateRules(rules);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].message, 'first');
  assert.ok(warnings.includes('RULE_INVALID: dup'));
});

test('validateRules: forbid + when together -> RULE_INVALID', () => {
  const { valid, warnings } = validateRules([{ id: 'both', message: 'm', forbid: 'a', when: 'b', require: 'c' }]);
  assert.equal(valid.length, 0);
  assert.ok(warnings.includes('RULE_INVALID: both'));
});

test('validateRules: when without require -> RULE_INVALID', () => {
  const { valid, warnings } = validateRules([{ id: 'no-req', message: 'm', when: 'a' }]);
  assert.equal(valid.length, 0);
  assert.ok(warnings.includes('RULE_INVALID: no-req'));
});

test('validateRules: bad scope value -> RULE_INVALID', () => {
  const { valid, warnings } = validateRules([{ id: 'bad-scope', message: 'm', forbid: 'a', scope: 'partial' }]);
  assert.equal(valid.length, 0);
  assert.ok(warnings.includes('RULE_INVALID: bad-scope'));
});

test('validateRules: unparsable regex -> RULE_INVALID_REGEX, rule dropped', () => {
  const { valid, warnings } = validateRules([{ id: 'bad-re', message: 'm', forbid: '[unclosed' }]);
  assert.equal(valid.length, 0);
  assert.ok(warnings.includes('RULE_INVALID_REGEX: bad-re'));
});

test('validateRules: a valid rule alongside an invalid one is normalized and kept', () => {
  const { valid, warnings } = validateRules([
    { id: 'ok', message: 'fine', forbid: 'x', glob: ['**/*.java'] },
    { id: 'broken' }, // missing forbid/when entirely
  ]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].id, 'ok');
  assert.equal(valid[0].scope, 'diff', 'defaults to diff scope');
  assert.ok(valid[0].forbid instanceof RegExp);
  assert.ok(warnings.includes('RULE_INVALID: broken'));
});

// ---------------------------------------------------------------------------
// No valid rules at all -> skippedReason, never a crash.
// ---------------------------------------------------------------------------

test('evaluateRules: empty rules array -> skippedReason, no violations', () => {
  const dir = initRepo({});
  const result = evaluateRules({ rootDir: dir, scanPath: '.', rules: [], base: 'main' });
  assert.deepEqual(result.violations, []);
  assert.equal(result.preexisting, 0);
  assert.equal(result.skippedReason, 'NO_VALID_RULES');
});
