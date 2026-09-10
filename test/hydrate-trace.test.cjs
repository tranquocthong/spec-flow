/**
 * Unit tests for core.hydrateTrace — US-1 of slim-flow-overhead.
 *
 * trace.json stopped persisting data that is re-derivable from file-links.json
 * and tasks.json (measured: 63.2% of 4,051 links and 40.9% of 3,166 nodes across
 * 31 real features). hydrateTrace puts it back at READ time so trace-impact and
 * state-update see exactly what they saw before.
 *
 * Run:  node --test test/hydrate-trace.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../lib/core.cjs');

function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-hydrate-'));
  try { process.chdir(dir); return fn(dir); }
  finally { process.chdir(prev); }
}

/** Seed .spec-flow/specs/<f>/file-links.json and .taskmaster/tasks/tasks.json. */
function seed(feature, links, tasks) {
  fs.mkdirSync(path.join('.spec-flow', 'specs', feature), { recursive: true });
  fs.writeFileSync(path.join('.spec-flow', 'specs', feature, 'file-links.json'),
    JSON.stringify({ links }));
  fs.mkdirSync(path.join('.taskmaster', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join('.taskmaster', 'tasks', 'tasks.json'),
    JSON.stringify({ [feature]: { tasks } }));
}

const SLIM = () => ({
  feature: 'f',
  nodes: { fr: [{ id: 'FR-001', text: 't', priority: 'Must Have', source: '' }], tc: [], nfr: [], errors: [], states: [] },
  links: [{ from: 'FR-001', to: 'TC-001', type: 'fr-tc' }],
});

test('hydrateTrace: rebuilds nodes.files and nodes.tasks from their own stores', () => {
  inTmp(() => {
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }, { task: '1', fr: 'FR-001', file: 'src/b.js' }],
            [{ id: 1, title: 'do a', status: 'done' }]);
    const h = core.hydrateTrace('f', SLIM());
    assert.deepEqual(h.nodes.files.map(n => n.path).sort(), ['src/a.js', 'src/b.js']);
    assert.deepEqual(h.nodes.tasks, [{ id: '1', title: 'do a', status: 'done' }]);
  });
});

test('hydrateTrace: rebuilds task-file, fr-file and fr-task links', () => {
  inTmp(() => {
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }], [{ id: 1, title: 'x', status: 'done' }]);
    const h = core.hydrateTrace('f', SLIM());
    const has = (from, to, type) => h.links.some(l => l.from === from && l.to === to && l.type === type);
    assert.ok(has('1', 'src/a.js', 'task-file'), 'task-file link');
    assert.ok(has('FR-001', 'src/a.js', 'fr-file'), 'fr-file link');
    assert.ok(has('FR-001', '1', 'fr-task'), 'fr-task link');
    assert.ok(has('FR-001', 'TC-001', 'fr-tc'), 'authoritative links are preserved');
  });
});

test('hydrateTrace: does NOT mutate its input (D2)', () => {
  inTmp(() => {
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }], [{ id: 1, title: 'x', status: 'done' }]);
    const input = SLIM();
    const snapshot = JSON.stringify(input);
    core.hydrateTrace('f', input);
    assert.equal(JSON.stringify(input), snapshot, 'input trace must be untouched');
  });
});

test('hydrateTrace: idempotent on an OLD-format trace that already carries derived data (D4)', () => {
  inTmp(() => {
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }], [{ id: 1, title: 'x', status: 'done' }]);
    const fat = SLIM();
    // Simulate a trace written by the pre-change engine.
    fat.nodes.files = [{ path: 'src/a.js' }];
    fat.nodes.tasks = [{ id: '1', title: 'x', status: 'done' }];
    fat.links.push({ from: '1', to: 'src/a.js', type: 'task-file' });
    fat.links.push({ from: 'FR-001', to: 'src/a.js', type: 'fr-file' });
    fat.links.push({ from: 'FR-001', to: '1', type: 'fr-task' });
    const h = core.hydrateTrace('f', fat);
    assert.equal(h.nodes.files.length, 1, 'nodes.files must not duplicate');
    assert.equal(h.nodes.tasks.length, 1, 'nodes.tasks must not duplicate');
    const key = l => `${l.from}|${l.to}|${l.type}`;
    assert.equal(new Set(h.links.map(key)).size, h.links.length, 'no duplicate links');
    // Hydrating twice must be stable.
    assert.equal(JSON.stringify(core.hydrateTrace('f', h)), JSON.stringify(h));
  });
});

test('hydrateTrace: missing file-links.json yields empty derived data, never throws', () => {
  inTmp(() => {
    fs.mkdirSync(path.join('.spec-flow', 'specs', 'f'), { recursive: true });
    const h = core.hydrateTrace('f', SLIM());
    assert.deepEqual(h.nodes.files, []);
    assert.deepEqual(h.nodes.tasks, []);
    assert.equal(h.links.length, 1, 'only the authoritative link remains');
    assert.ok(!h.warnings || !h.warnings.length, 'an absent store is normal, not a warning');
  });
});

test('hydrateTrace: unreadable tasks.json omits task nodes and reports TRACE_HYDRATE_PARTIAL', () => {
  inTmp(() => {
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }], []);
    fs.writeFileSync(path.join('.taskmaster', 'tasks', 'tasks.json'), '{ this is not json');
    const h = core.hydrateTrace('f', SLIM());
    assert.deepEqual(h.nodes.tasks, [], 'task nodes omitted');
    assert.ok((h.warnings || []).some(w => w.startsWith('TRACE_HYDRATE_PARTIAL')),
      'a corrupt store must be surfaced, not silently swallowed');
    assert.ok(h.nodes.files.length === 1, 'file-links still hydrated independently');
  });
});

test('hydrateTrace: a null/absent trace is returned as-is', () => {
  inTmp(() => {
    assert.equal(core.hydrateTrace('f', null), null);
  });
});

test('hydrateTrace: a null feature falls back to trace.feature and never throws', () => {
  inTmp(() => {
    // The global .spec-flow/trace.json mirror is read with NO feature argument
    // (resolveActiveFeature / state-update without --feature — and every command's
    // re-anchor line tells the agent to "run state-update after each step" with no
    // --feature). fileLinksPathFor(null) throws on path.join, so an unguarded
    // hydrate turned that documented path into `INTERNAL: path argument must be of
    // type string`. hydrateTrace's contract says it never throws; hold it to that.
    seed('f', [{ task: '1', fr: 'FR-001', file: 'src/a.js' }], [{ id: 1, title: 'x', status: 'done' }]);
    const t = SLIM();            // carries feature: 'f'
    const h = core.hydrateTrace(null, t);
    assert.ok(h, 'must return a trace, not throw');
    assert.deepEqual(h.nodes.files.map(n => n.path), ['src/a.js'],
      'falls back to trace.feature so the mirror still hydrates');
  });
});

test('hydrateTrace: no feature anywhere skips file-links instead of throwing', () => {
  inTmp(() => {
    const t = SLIM();
    delete t.feature;
    const h = core.hydrateTrace(undefined, t);
    assert.ok(h);
    assert.deepEqual(h.nodes.files, [], 'nothing to scope to → empty, not an exception');
    assert.equal(h.links.length, 1, 'authoritative links survive');
  });
});
