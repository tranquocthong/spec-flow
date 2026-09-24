/**
 * Unit tests for lib/backlog.cjs — shared backlog record helpers (parse,
 * legacy detection, sort, next-id). Direct-require, mkdtemp-isolated temp
 * dirs passed straight to readRecords()/nextNum() (no chdir needed — every
 * function here takes its target dir as an explicit argument).
 *
 * Run:  node --test test/backlog.test.cjs   (or: node --test test/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backlog = require('../lib/backlog.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-backlog-'));
}
function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

const MARKER = '<!-- spec-flow backlog record -->';

function recordContent({ title = 'Test item', id = 'bl-001', created = '2026-09-24T00:00:00.000Z', priority = 'medium', status = 'open', feature = 'TBD', epic = 'none' } = {}) {
  return [
    `# ${title}`,
    '',
    MARKER,
    `id: ${id}`,
    `created: ${created}`,
    `priority: ${priority}`,
    `status: ${status}`,
    `feature: ${feature}`,
    `epic: ${epic}`,
    '',
    '## Description',
    '',
    '## Notes',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports the exact constant shapes SD §6.3 D2/D3 + §7 lock in', () => {
  assert.deepEqual(backlog.BACKLOG_VALID_PRIORITIES, ['high', 'medium', 'low']);
  assert.deepEqual(backlog.BACKLOG_VALID_STATUSES, ['open', 'done', 'dropped']);
  assert.equal(backlog.BACKLOG_MARKER, '<!-- spec-flow backlog record -->');
});

// ---------------------------------------------------------------------------
// parseRecord — marker records
// ---------------------------------------------------------------------------

test('parseRecord: marker record reads all key:value fields + heading title', () => {
  const content = recordContent({ title: 'Add retry queue', id: 'bl-003', priority: 'high', status: 'open', feature: 'outbox-cdc', epic: 'reliability' });
  const item = backlog.parseRecord('003-bl-add-retry-queue.md', content);
  assert.equal(item.id, 'bl-003');
  assert.equal(item.title, 'Add retry queue');
  assert.equal(item.priority, 'high');
  assert.equal(item.status, 'open');
  assert.equal(item.feature, 'outbox-cdc');
  assert.equal(item.epic, 'reliability');
  assert.equal(item.created, '2026-09-24T00:00:00.000Z');
  assert.equal(item.legacy, false);
});

test('parseRecord: marker record with invalid priority/status line falls back to unset/open', () => {
  const content = recordContent({ priority: 'critical', status: 'blocked' });
  const item = backlog.parseRecord('001-bl-x.md', content);
  assert.equal(item.priority, 'unset');
  assert.equal(item.status, 'open');
});

// ---------------------------------------------------------------------------
// parseRecord — legacy (no marker) records
// ---------------------------------------------------------------------------

test('parseRecord: legacy record has no marker → legacy:true, id from filename, defaults', () => {
  const content = '# Some free-form note\n\nNo structure here at all.\n';
  const item = backlog.parseRecord('backlog-idea.md', content);
  assert.equal(item.legacy, true);
  assert.equal(item.id, 'backlog-idea');
  assert.equal(item.title, 'Some free-form note');
  assert.equal(item.priority, 'unset');
  assert.equal(item.status, 'open');
});

test('parseRecord: legacy record strips leading "Backlog —" / "Backlog -" title prefix', () => {
  const emDash = backlog.parseRecord('a.md', '# Backlog — Improve caching\n');
  assert.equal(emDash.title, 'Improve caching');
  const hyphen = backlog.parseRecord('b.md', '# Backlog - Improve caching\n');
  assert.equal(hyphen.title, 'Improve caching');
});

test('parseRecord: legacy record honors valid priority:/status: lines when present', () => {
  const content = '# Legacy with fields\n\npriority: low\nstatus: dropped\n';
  const item = backlog.parseRecord('c.md', content);
  assert.equal(item.priority, 'low');
  assert.equal(item.status, 'dropped');
});

test('parseRecord: legacy record with invalid priority:/status: value falls back to unset/open', () => {
  const content = '# Legacy with bad fields\n\npriority: P0\nstatus: pending\n';
  const item = backlog.parseRecord('d.md', content);
  assert.equal(item.priority, 'unset');
  assert.equal(item.status, 'open');
});

// ---------------------------------------------------------------------------
// readRecords
// ---------------------------------------------------------------------------

test('readRecords: missing dir returns []', () => {
  const dir = tmpDir();
  const r = backlog.readRecords(path.join(dir, 'does-not-exist'));
  assert.deepEqual(r, []);
});

test('readRecords: reads only .md files, includes path, mixes marker + legacy', () => {
  const dir = tmpDir();
  write(dir, '001-bl-foo.md', recordContent({ id: 'bl-001', title: 'Foo' }));
  write(dir, 'legacy-note.md', '# Legacy note\n');
  write(dir, 'README.txt', 'not markdown');
  const items = backlog.readRecords(dir);
  assert.equal(items.length, 2);
  const ids = items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['bl-001', 'legacy-note']);
  for (const it of items) assert.equal(it.path, path.join(dir, it.legacy ? 'legacy-note.md' : '001-bl-foo.md'));
});

test('readRecords: read-only — never modifies file content on disk', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'legacy.md');
  const original = '# Untouched legacy file\n\nSome body text.\n';
  write(dir, 'legacy.md', original);
  backlog.readRecords(dir);
  assert.equal(fs.readFileSync(p, 'utf8'), original);
});

// ---------------------------------------------------------------------------
// compareItems
// ---------------------------------------------------------------------------

test('compareItems: priority order high > medium > low > unset', () => {
  const items = [
    { priority: 'low', created: '2026-01-01T00:00:00.000Z', path: '/x/low.md' },
    { priority: 'unset', created: '2026-01-01T00:00:00.000Z', path: '/x/unset.md' },
    { priority: 'high', created: '2026-01-01T00:00:00.000Z', path: '/x/high.md' },
    { priority: 'medium', created: '2026-01-01T00:00:00.000Z', path: '/x/medium.md' },
  ];
  const sorted = items.slice().sort(backlog.compareItems).map((i) => i.priority);
  assert.deepEqual(sorted, ['high', 'medium', 'low', 'unset']);
});

test('compareItems: same priority sorts by created ascending (oldest first)', () => {
  const items = [
    { priority: 'high', created: '2026-03-01T00:00:00.000Z', path: '/x/c.md' },
    { priority: 'high', created: '2026-01-01T00:00:00.000Z', path: '/x/a.md' },
    { priority: 'high', created: '2026-02-01T00:00:00.000Z', path: '/x/b.md' },
  ];
  const sorted = items.slice().sort(backlog.compareItems).map((i) => path.basename(i.path));
  assert.deepEqual(sorted, ['a.md', 'b.md', 'c.md']);
});

test('compareItems: missing created sorts after present created within same priority', () => {
  const items = [
    { priority: 'high', created: null, path: '/x/no-date.md' },
    { priority: 'high', created: '2026-01-01T00:00:00.000Z', path: '/x/has-date.md' },
  ];
  const sorted = items.slice().sort(backlog.compareItems).map((i) => path.basename(i.path));
  assert.deepEqual(sorted, ['has-date.md', 'no-date.md']);
});

test('compareItems: same priority + created ties break on filename', () => {
  const items = [
    { priority: 'high', created: '2026-01-01T00:00:00.000Z', path: '/x/zzz.md' },
    { priority: 'high', created: '2026-01-01T00:00:00.000Z', path: '/x/aaa.md' },
  ];
  const sorted = items.slice().sort(backlog.compareItems).map((i) => path.basename(i.path));
  assert.deepEqual(sorted, ['aaa.md', 'zzz.md']);
});

test('readRecords + compareItems together: TC-001 style 3-item sort', () => {
  const dir = tmpDir();
  write(dir, '001-bl-low.md', recordContent({ id: 'bl-001', priority: 'low', created: '2026-01-01T00:00:00.000Z' }));
  write(dir, '002-bl-high.md', recordContent({ id: 'bl-002', priority: 'high', created: '2026-01-02T00:00:00.000Z' }));
  write(dir, '003-bl-medium.md', recordContent({ id: 'bl-003', priority: 'medium', created: '2026-01-03T00:00:00.000Z' }));
  const items = backlog.readRecords(dir).sort(backlog.compareItems);
  assert.deepEqual(items.map((i) => i.id), ['bl-002', 'bl-003', 'bl-001']);
});

// ---------------------------------------------------------------------------
// nextNum — TC-004 style: max prefix, not a file count
// ---------------------------------------------------------------------------

test('nextNum: empty/missing dir → "001"', () => {
  const dir = tmpDir();
  assert.equal(backlog.nextNum(path.join(dir, 'nope')), '001');
  assert.equal(backlog.nextNum(dir), '001');
});

test('nextNum: uses max numeric "-bl-" prefix + 1, not a file count (gap-safe)', () => {
  const dir = tmpDir();
  write(dir, '003-bl-x.md', recordContent({ id: 'bl-003' }));
  assert.equal(backlog.nextNum(dir), '004');
});

test('nextNum: legacy files without a numeric "-bl-" prefix do not affect numbering', () => {
  const dir = tmpDir();
  write(dir, '001-bl-a.md', recordContent({ id: 'bl-001' }));
  write(dir, 'legacy-note.md', '# Legacy\n');
  assert.equal(backlog.nextNum(dir), '002');
});
