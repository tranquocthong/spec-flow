/**
 * Engine test net for the `backlog-new` / `backlog-list` / `backlog-set`
 * commands in bin/flow-tools.cjs — mirrors test/flow-tools.test.cjs's
 * bug-new/bug-list pattern: real CLI invocation (`node flow-tools.cjs <cmd>`)
 * in a throwaway temp project, asserting on the JSON Result contract.
 *
 * Contract: .spec-flow/specs/backlog-registry/SD.md §5.1 FR-001..FR-021,
 * FR-026, §13.2 TC-001..TC-023 (subset relevant to these three commands).
 *
 * Run:  node --test test/backlog-commands.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');

/** Run the engine; return the parsed Result even when it exits non-zero (ok:false). */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-backlog-cmd-'));
  return dir;
}

function initProject(dir) {
  const r = run(['init-project', '--stack', 'node'], dir);
  assert.equal(r.ok, true, 'init-project should succeed');
  return r;
}

function backlogDir(dir) {
  return path.join(dir, '.spec-flow', 'backlog');
}

// ---------------------------------------------------------------------------
// backlog-new — FR-001..FR-009, FR-026 (task 2)
// ---------------------------------------------------------------------------

test('backlog-new happy path: writes a marker record and returns ok({id,path,priority})', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['backlog-new', '--title', 'Test item', '--priority', 'medium', '--feature', 'feat-x', '--epic', 'epic-y'], dir);
  assert.equal(r.ok, true, 'backlog-new ok');
  assert.equal(r.data.id, 'bl-001');
  assert.equal(r.data.priority, 'medium');
  const writtenPath = path.join(dir, r.data.path);
  assert.ok(fs.existsSync(writtenPath), 'file written at returned path');
  const content = fs.readFileSync(writtenPath, 'utf8');
  assert.match(content, /<!-- spec-flow backlog record -->/);
  assert.match(content, /^id: bl-001$/m);
  assert.match(content, /^created: \S+$/m);
  assert.match(content, /^priority: medium$/m);
  assert.match(content, /^status: open$/m);
  assert.match(content, /^feature: feat-x$/m);
  assert.match(content, /^epic: epic-y$/m);
  assert.match(content, /^## Description$/m);
  assert.match(content, /^## Notes$/m);
});

test('backlog-new numbers from the max existing "-bl-" prefix, not a file count', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  fs.writeFileSync(path.join(backlogDir(dir), '003-bl-x.md'), '# x\n\n<!-- spec-flow backlog record -->\nid: bl-003\n');
  const r = run(['backlog-new', '--title', 'gap regression', '--priority', 'high'], dir);
  assert.equal(r.ok, true, 'backlog-new ok');
  assert.equal(r.data.id, 'bl-004', 'next id skips past the gap instead of recolliding with bl-003');
});

test('backlog-new missing --title -> MISSING_ARG, no file created', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['backlog-new', '--priority', 'high'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^MISSING_ARG/);
  assert.ok(!fs.existsSync(backlogDir(dir)) || fs.readdirSync(backlogDir(dir)).length === 0, 'no file written');
});

test('backlog-new missing --priority -> MISSING_ARG, no file created', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['backlog-new', '--title', 'foo'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^MISSING_ARG/);
  assert.ok(!fs.existsSync(backlogDir(dir)) || fs.readdirSync(backlogDir(dir)).length === 0, 'no file written');
});

test('backlog-new invalid --priority -> INVALID_PRIORITY listing valid values, no file created', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['backlog-new', '--title', 'x', '--priority', 'P0'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^INVALID_PRIORITY/);
  assert.match(r.error, /high/);
  assert.match(r.error, /medium/);
  assert.match(r.error, /low/);
  assert.ok(!fs.existsSync(backlogDir(dir)) || fs.readdirSync(backlogDir(dir)).length === 0, 'no file written');
});

test('backlog-new creates backlog/ when missing (ensureDir)', () => {
  const dir = tmpProject();
  initProject(dir);
  assert.ok(!fs.existsSync(backlogDir(dir)), 'backlog dir does not exist yet');
  const r = run(['backlog-new', '--title', 'x', '--priority', 'high'], dir);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(backlogDir(dir)), 'backlog dir created');
});

// ---------------------------------------------------------------------------
// backlog-list — FR-010..FR-016 (task 3)
// ---------------------------------------------------------------------------

test('backlog-list sorts by priority: high before medium before low (TC-001 style)', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['backlog-new', '--title', 'low one', '--priority', 'low'], dir);
  run(['backlog-new', '--title', 'high one', '--priority', 'high'], dir);
  run(['backlog-new', '--title', 'medium one', '--priority', 'medium'], dir);
  const r = run(['backlog-list'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.items.map((i) => i.priority), ['high', 'medium', 'low']);
});

test('backlog-list mixes legacy + marker records; legacy has priority unset, legacy:true', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  fs.writeFileSync(path.join(backlogDir(dir), 'legacy-note.md'), '# A legacy note\n\nSome free-form body.\n');
  run(['backlog-new', '--title', 'structured item', '--priority', 'medium'], dir);
  const r = run(['backlog-list'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 2);
  const legacyItem = r.data.items.find((i) => i.legacy === true);
  assert.ok(legacyItem, 'legacy item present');
  assert.equal(legacyItem.priority, 'unset');
  assert.equal(legacyItem.id, 'legacy-note');
});

test('backlog-list item shape has all fields + return envelope with counts (TC-021)', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['backlog-new', '--title', 'shape check', '--priority', 'medium', '--feature', 'feat-x', '--epic', 'epic-y'], dir);
  const r = run(['backlog-list'], dir);
  assert.equal(r.ok, true);
  const item = r.data.items[0];
  for (const key of ['id', 'title', 'priority', 'status', 'feature', 'epic', 'created', 'path', 'legacy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(item, key), `item has ${key}`);
  }
  assert.deepEqual(r.data.counts, { high: 0, medium: 1, low: 0, unset: 0 });
});

test('backlog-list on missing backlog/ dir -> ok({items:[],counts:zeros}), no error (TC-016)', () => {
  const dir = tmpProject();
  initProject(dir);
  assert.ok(!fs.existsSync(backlogDir(dir)));
  const r = run(['backlog-list'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { items: [], counts: { high: 0, medium: 0, low: 0, unset: 0 } });
  assert.ok(!fs.existsSync(backlogDir(dir)), 'backlog-list never creates backlog/ (strictly read-only)');
});

test('backlog-list --epic filters exact-match (TC-015)', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['backlog-new', '--title', 'a1', '--priority', 'high', '--epic', 'A'], dir);
  run(['backlog-new', '--title', 'a2', '--priority', 'medium', '--epic', 'A'], dir);
  run(['backlog-new', '--title', 'b1', '--priority', 'low', '--epic', 'B'], dir);
  const r = run(['backlog-list', '--epic', 'A'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 2);
  assert.ok(r.data.items.every((i) => i.epic === 'A'));
});

test('backlog-list --status defaults to open, filtering out non-open legacy status lines', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  fs.writeFileSync(path.join(backlogDir(dir), 'legacy-done.md'), '# Legacy done\n\nstatus: done\n');
  const openList = run(['backlog-list'], dir);
  assert.equal(openList.ok, true);
  assert.deepEqual(openList.data.items, []);
  const allList = run(['backlog-list', '--status', 'all'], dir);
  assert.equal(allList.ok, true);
  assert.equal(allList.data.items.length, 1);
});

test('backlog-list is strictly read-only: legacy file bytes untouched after listing (TC-022)', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  const legacyPath = path.join(backlogDir(dir), 'legacy.md');
  const original = '# Untouched legacy file\n\nSome body text.\n';
  fs.writeFileSync(legacyPath, original);
  run(['backlog-list'], dir);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), original);
});

// ---------------------------------------------------------------------------
// backlog-set — FR-017..FR-021 (task 4)
// ---------------------------------------------------------------------------

test('backlog-set updates status in place; item leaves default (open) list, appears with --status all (TC-005)', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['backlog-new', '--title', 'done me', '--priority', 'high'], dir);
  assert.equal(created.ok, true);
  const setR = run(['backlog-set', '--id', created.data.id, '--status', 'done'], dir);
  assert.equal(setR.ok, true, 'backlog-set ok');
  const openList = run(['backlog-list'], dir);
  assert.deepEqual(openList.data.items.map((i) => i.id), []);
  const allList = run(['backlog-list', '--status', 'all'], dir);
  assert.deepEqual(allList.data.items.map((i) => i.id), [created.data.id]);
});

test('backlog-set return shape: ok({id,priority,status}) has both fields even when only one changed (TC-023)', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['backlog-new', '--title', 'both fields', '--priority', 'low'], dir);
  const setR = run(['backlog-set', '--id', created.data.id, '--priority', 'high'], dir);
  assert.equal(setR.ok, true);
  assert.deepEqual(setR.data, { id: created.data.id, priority: 'high', status: 'open' });
});

test('backlog-set on legacy file without a priority: line inserts it under the first heading, rest byte-for-byte (TC-014)', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  const legacyPath = path.join(backlogDir(dir), 'backlog-foo.md');
  const original = '# Backlog foo\n\nSome free-form body text.\nMore lines here.\n';
  fs.writeFileSync(legacyPath, original);
  const setR = run(['backlog-set', '--id', 'backlog-foo', '--priority', 'high'], dir);
  assert.equal(setR.ok, true, 'backlog-set ok');
  assert.equal(setR.data.priority, 'high');
  const updated = fs.readFileSync(legacyPath, 'utf8');
  assert.match(updated, /^priority: high$/m);
  // Rest of the original body must be untouched — every original line is still present.
  for (const line of original.split('\n')) {
    if (line.trim()) assert.ok(updated.includes(line), `original line preserved: ${line}`);
  }
});

test('backlog-set --id matches no file -> NOT_FOUND', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['backlog-new', '--title', 'exists', '--priority', 'high'], dir);
  const r = run(['backlog-set', '--id', 'bl-999', '--status', 'done'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^NOT_FOUND/);
});

test('backlog-set --id matches multiple files -> AMBIGUOUS_ID with the matches listed', () => {
  const dir = tmpProject();
  initProject(dir);
  fs.mkdirSync(backlogDir(dir), { recursive: true });
  fs.writeFileSync(path.join(backlogDir(dir), '001-bl-foo.md'), '# Foo one\n\n<!-- spec-flow backlog record -->\nid: bl-001\ncreated: 2026-01-01T00:00:00.000Z\npriority: high\nstatus: open\nfeature: TBD\nepic: none\n');
  fs.writeFileSync(path.join(backlogDir(dir), '002-bl-foo.md'), '# Foo two\n\n<!-- spec-flow backlog record -->\nid: bl-002\ncreated: 2026-01-01T00:00:00.000Z\npriority: low\nstatus: open\nfeature: TBD\nepic: none\n');
  const r = run(['backlog-set', '--id', 'foo', '--status', 'done'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^AMBIGUOUS_ID/);
  assert.match(r.error, /001-bl-foo\.md/);
  assert.match(r.error, /002-bl-foo\.md/);
});

test('backlog-set with neither --priority nor --status -> MISSING_ARG (TC-013)', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['backlog-new', '--title', 'x', '--priority', 'high'], dir);
  const r = run(['backlog-set', '--id', created.data.id], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^MISSING_ARG/);
});

test('backlog-set --status with invalid value -> INVALID_STATUS (TC-018)', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['backlog-new', '--title', 'x', '--priority', 'high'], dir);
  const r = run(['backlog-set', '--id', created.data.id, '--status', 'pending'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^INVALID_STATUS/);
});

test('backlog-set --priority with invalid value -> INVALID_PRIORITY', () => {
  const dir = tmpProject();
  initProject(dir);
  const created = run(['backlog-new', '--title', 'x', '--priority', 'high'], dir);
  const r = run(['backlog-set', '--id', created.data.id, '--priority', 'P0'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /^INVALID_PRIORITY/);
});
