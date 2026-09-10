/**
 * Unit tests for lib/drift.cjs — the Layer-2 semantic drift-check (SD §12.2 error codes
 * vs the executor's implementation logs in tasks.json). Direct-require, chdir-to-tmp
 * (the command reads .spec-flow/ + .taskmaster/ relative to cwd).
 *
 * Run:  node --test test/drift.test.cjs   (or: node --test test/*.test.cjs)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const drift = require('../lib/drift.cjs');

function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-drift-'));
  try { process.chdir(dir); return fn(dir); }
  finally { process.chdir(prev); }
}

function writeTrace(errors) {
  fs.mkdirSync('.spec-flow/specs/demo', { recursive: true });
  const trace = { feature: 'demo', nodes: { errors } };
  fs.writeFileSync('.spec-flow/specs/demo/trace.json', JSON.stringify(trace));
  fs.writeFileSync('.spec-flow/trace.json', JSON.stringify(trace));
}
function writeTasks(detailsArr) {
  fs.mkdirSync('.taskmaster/tasks', { recursive: true });
  const tasks = detailsArr.map((d, i) => ({ id: i + 1, title: 't' + i, details: d }));
  fs.writeFileSync('.taskmaster/tasks/tasks.json', JSON.stringify({ demo: { tasks } }));
}

test('drift-check: NO_TRACE before trace-build', () => {
  inTmp(() => {
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, false);
    assert.match(r.error, /NO_TRACE/);
  });
});

test('drift-check: nothing to compare against → clean:null, not a false clean:true', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }]);
    writeTasks([]);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, true);
    // CONTRACT CHANGE: this used to return clean:true, which read as "no drift"
    // while actually having read nothing at all — a false negative. With neither
    // source available the honest answer is UNDETERMINED.
    assert.equal(r.data.clean, null, 'no source and no logs means undetermined, not clean');
    assert.match(r.data.note, /UNDETERMINED/);
    assert.deepEqual(r.data.drift, [], 'still must not flag every SD code as drift');
  });
});

test('drift-check: flags spec-not-evidenced + impl-not-specced error codes', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }, { code: 'ERR_BAR_002', http: '404' }]);
    // Log mentions FOO (evidenced) and BAZ (not in SD), but never BAR (spec-not-evidenced).
    writeTasks(['login done; returns ERR_FOO_001 on bad creds; added ERR_BAZ_003 for lockout']);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.ok, true);
    assert.equal(r.data.clean, false);
    assert.ok(r.data.evidencedErrorCodes.includes('ERR_FOO_001'), 'FOO evidenced in logs');
    const byCode = Object.fromEntries(r.data.drift.map((d) => [d.code, d.type]));
    assert.equal(byCode['ERR_BAR_002'], 'spec-not-evidenced', 'SD code with no log mention');
    assert.equal(byCode['ERR_BAZ_003'], 'impl-not-specced', 'logged code not in SD §12.2');
  });
});

test('drift-check: all SD codes evidenced → clean', () => {
  inTmp(() => {
    writeTrace([{ code: 'ERR_FOO_001', http: '422' }]);
    writeTasks(['handled error ERR_FOO_001 as specified']);
    const r = drift['drift-check']({ feature: 'demo' });
    assert.equal(r.data.clean, true);
    assert.deepEqual(r.data.drift, []);
  });
});

// --- drift-check must read the CODE, not the agent's own task notes --------
// Task logs come from `update-task --append`, which is now opt-in (US-7) and
// was in fact broken for its whole life (`--id=<id>` was rejected by the CLI).
// So the log-only source made drift-check return clean:true with no input --
// a false negative, worse than silence. The source of truth is the code that
// actually shipped, scanned deterministically with no AI op.

const fsD = require('node:fs');
const osD = require('node:os');
const pathD = require('node:path');

function driftProject(fn) {
  const prev = process.cwd();
  const dir = fsD.mkdtempSync(pathD.join(osD.tmpdir(), 'sf-drift-'));
  try {
    process.chdir(dir);
    fsD.mkdirSync(pathD.join('.spec-flow', 'specs', 'f'), { recursive: true });
    fsD.mkdirSync('src', { recursive: true });
    fsD.writeFileSync(pathD.join('.spec-flow', 'config.json'), JSON.stringify({
      project: 'f', stack: 'node',
      conventions: { errorCodePrefix: 'ERR_' },
      verify: { scanPath: 'src' },
    }));
    return fn(dir);
  } finally { process.chdir(prev); }
}

/** Seed a trace whose §12.2 declares `codes`, and source files containing `inCode`. */
function seedDrift(codes, inCode) {
  fsD.writeFileSync(pathD.join('.spec-flow', 'specs', 'f', 'trace.json'), JSON.stringify({
    feature: 'f',
    nodes: { fr: [], tc: [], nfr: [], states: [], errors: codes.map(c => ({ code: c, http: '400', trigger: 't' })) },
    links: [],
  }));
  fsD.writeFileSync(pathD.join('src', 'handler.js'),
    inCode.map(c => `  throw new AppError('${c}');`).join('\n'));
}

test('drift-check: an SD code missing from the code is flagged, with no task logs at all', () => {
  driftProject(() => {
    seedDrift(['ERR_ALPHA', 'ERR_BETA'], ['ERR_ALPHA']);
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.ok, true);
    assert.equal(r.data.clean, false, 'must NOT report clean when a spec code is unimplemented');
    const d = r.data.drift.find(x => x.code === 'ERR_BETA');
    assert.ok(d, 'ERR_BETA is in §12.2 but absent from src/ — must be flagged');
    assert.equal(d.type, 'spec-not-evidenced');
  });
});

test('drift-check: a code in the source that §12.2 does not document is flagged', () => {
  driftProject(() => {
    seedDrift(['ERR_ALPHA'], ['ERR_ALPHA', 'ERR_SURPRISE']);
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.data.clean, false);
    const d = r.data.drift.find(x => x.code === 'ERR_SURPRISE');
    assert.ok(d, 'a code shipped but unspecced must be flagged');
    assert.equal(d.type, 'impl-not-specced');
  });
});

test('drift-check: fully matching spec and code is clean', () => {
  driftProject(() => {
    seedDrift(['ERR_ALPHA', 'ERR_BETA'], ['ERR_ALPHA', 'ERR_BETA']);
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.data.clean, true);
    assert.deepEqual(r.data.drift, []);
  });
});

test('drift-check: no scannable source yields clean:null, never a false clean:true', () => {
  driftProject(() => {
    seedDrift(['ERR_ALPHA'], []);
    fsD.rmSync('src', { recursive: true, force: true });
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.ok, true);
    assert.equal(r.data.clean, null,
      'with nothing to scan the answer is UNDETERMINED — clean:true would be a false negative');
    assert.match(r.data.note, /scan/i);
  });
});

test('drift-check: scopes the scan to the files THIS feature touched', () => {
  driftProject(() => {
    // Feature f declares ERR_ALPHA and touched only src/mine.js.
    seedDrift(['ERR_ALPHA'], ['ERR_ALPHA']);
    fsD.renameSync(pathD.join('src', 'handler.js'), pathD.join('src', 'mine.js'));
    // A neighbouring file belongs to a DIFFERENT feature and must not be flagged.
    fsD.writeFileSync(pathD.join('src', 'someone-else.js'), "throw new AppError('ERR_NOT_MINE');");
    fsD.writeFileSync(pathD.join('.spec-flow', 'specs', 'f', 'file-links.json'),
      JSON.stringify({ links: [{ task: '1', fr: 'FR-001', file: 'src/mine.js' }] }));
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.ok, true);
    assert.ok(!r.data.drift.some(d => d.code === 'ERR_NOT_MINE'),
      "another feature's error code must not be reported as this feature's drift");
    assert.equal(r.data.clean, true);
    assert.match(String(r.data.source), /file-links/);
  });
});

test('drift-check: falls back to scanPath when the feature has no file-links yet', () => {
  driftProject(() => {
    seedDrift(['ERR_ALPHA'], ['ERR_ALPHA']);
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.data.clean, true, 'pre-implementation, scanPath is the only source');
    assert.match(String(r.data.source), /code/);
  });
});

test('drift-check: resolves repo-qualified file-links paths through config.repos', () => {
  driftProject((dir) => {
    // Multi-repo hub: the code lives in a SIBLING repo, and trace-link stored the
    // path repo-qualified ("svc-a/src/x.js"). Without resolving that through
    // config.repos the scan finds nothing and silently falls back to task logs —
    // which is the shape of every real multi-repo project.
    const sib = pathD.join(dir, '..', pathD.basename(dir) + '-svc-a');
    fsD.mkdirSync(pathD.join(sib, 'src'), { recursive: true });
    fsD.writeFileSync(pathD.join(sib, 'src', 'x.js'), "throw new AppError('ERR_ALPHA');");
    const cfgP = pathD.join('.spec-flow', 'config.json');
    const cfg = JSON.parse(fsD.readFileSync(cfgP, 'utf8'));
    cfg.repos = { 'svc-a': pathD.relative(dir, sib) };
    fsD.writeFileSync(cfgP, JSON.stringify(cfg));
    seedDrift(['ERR_ALPHA'], []);
    fsD.rmSync('src', { recursive: true, force: true });
    fsD.writeFileSync(pathD.join('.spec-flow', 'specs', 'f', 'file-links.json'),
      JSON.stringify({ links: [{ task: '1', fr: 'FR-001', file: 'svc-a/src/x.js' }] }));
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.ok, true);
    assert.match(String(r.data.source), /file-links/, 'must read the sibling repo, not fall back to logs');
    assert.deepEqual(r.data.evidencedErrorCodes, ['ERR_ALPHA']);
    assert.equal(r.data.clean, true);
  });
});

test('drift-check: spec-not-evidenced must search WIDE before claiming a code is missing', () => {
  driftProject(() => {
    // The asymmetry that matters. A feature declares ERR_ALPHA and implements it in
    // src/elsewhere.js — a file the executor never recorded via trace-link (real
    // file-links stores are routinely incomplete). Scoped-only search then "proves"
    // the code is missing when it plainly is not: verified against a shipped feature
    // whose §12.2 code lived in 4 files absent from its own 28-entry file-links.
    //
    //   spec-not-evidenced -> ABSENCE must be proven, so search wide.
    //   impl-not-specced   -> only code THIS feature wrote is relevant, so search narrow.
    seedDrift(['ERR_ALPHA'], []);
    fsD.writeFileSync(pathD.join('src', 'linked.js'), '// nothing interesting here');
    fsD.writeFileSync(pathD.join('src', 'elsewhere.js'), "throw new AppError('ERR_ALPHA');");
    fsD.writeFileSync(pathD.join('src', 'stranger.js'), "throw new AppError('ERR_OTHER_FEATURE');");
    fsD.writeFileSync(pathD.join('.spec-flow', 'specs', 'f', 'file-links.json'),
      JSON.stringify({ links: [{ task: '1', fr: 'FR-001', file: 'src/linked.js' }] }));
    const r = drift['drift-check']({ feature: 'f' });
    assert.equal(r.ok, true);
    assert.ok(!r.data.drift.some(d => d.type === 'spec-not-evidenced'),
      'ERR_ALPHA exists in src/elsewhere.js — must NOT be reported missing');
    assert.deepEqual(r.data.evidencedErrorCodes, ['ERR_ALPHA']);
    assert.ok(!r.data.drift.some(d => d.code === 'ERR_OTHER_FEATURE'),
      "a stranger's code outside file-links must NOT be attributed to this feature");
  });
});
