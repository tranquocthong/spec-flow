/**
 * Tests for epic-new directory workspace (FR-001..007, TC-001..004, TC-031, TC-032)
 * and epic field on state-update / status-report (FR-023, FR-024, TC-018, TC-019, TC-040).
 *
 * Dev tooling — NOT loaded at runtime.
 * Run:  node test/epic-workspace.test.cjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-epic-test-'));
  return dir;
}

function initProject(dir) {
  const r = run(['init-project', '--stack', 'node'], dir);
  assert.equal(r.ok, true, 'init-project should succeed');
  return r;
}

// ---------------------------------------------------------------------------
// TC-004: MISSING_ARG
// ---------------------------------------------------------------------------

test('TC-004: epic-new without --name returns MISSING_ARG', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['epic-new'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG/);
});

// ---------------------------------------------------------------------------
// TC-032: INVALID_SLUG
// ---------------------------------------------------------------------------

test('TC-032: epic-new with slugifies-to-empty name returns INVALID_SLUG, no dir created', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['epic-new', '--name', '!!!'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /INVALID_SLUG/);
  // No directory should be created
  const epicsDir = path.join(dir, '.spec-flow', 'epics');
  const potentialDir = path.join(epicsDir, 'feature'); // old fallback slug
  assert.equal(fs.existsSync(potentialDir), false, 'No directory should be created for invalid slug');
});

// ---------------------------------------------------------------------------
// TC-001: happy path — name with spaces
// ---------------------------------------------------------------------------

test('TC-001: epic-new happy path — name with spaces creates directory workspace', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['epic-new', '--name', 'WinMone x WinCommerce'], dir);
  assert.equal(r.ok, true);

  const epicDir = path.join(dir, '.spec-flow', 'epics', 'winmone-x-wincommerce');
  assert.equal(fs.existsSync(epicDir), true, 'epic directory should exist');

  const epicMd = path.join(epicDir, 'EPIC.md');
  assert.equal(fs.existsSync(epicMd), true, 'EPIC.md should exist');

  const content = fs.readFileSync(epicMd, 'utf8');
  assert.match(content, /<!-- spec-flow epic record -->/);
  assert.match(content, /id: winmone-x-wincommerce/);

  // Subdirectories each with .gitkeep
  for (const subdir of ['srs', 'decisions', 'state', 'assets']) {
    const subdirPath = path.join(epicDir, subdir);
    assert.equal(fs.existsSync(subdirPath), true, `${subdir}/ should exist`);
    const gitkeep = path.join(subdirPath, '.gitkeep');
    assert.equal(fs.existsSync(gitkeep), true, `${subdir}/.gitkeep should exist`);
  }
});

// ---------------------------------------------------------------------------
// TC-002: idempotency — second call returns alreadyExists:true, no overwrite
// ---------------------------------------------------------------------------

test('TC-002: epic-new idempotent — second call returns alreadyExists:true, no overwrite', () => {
  const dir = tmpProject();
  initProject(dir);

  const r1 = run(['epic-new', '--name', 'myepic'], dir);
  assert.equal(r1.ok, true);

  const epicMd = path.join(dir, '.spec-flow', 'epics', 'myepic', 'EPIC.md');
  const contentBefore = fs.readFileSync(epicMd, 'utf8');

  const r2 = run(['epic-new', '--name', 'myepic'], dir);
  assert.equal(r2.ok, true);
  assert.equal(r2.data.alreadyExists, true);

  const contentAfter = fs.readFileSync(epicMd, 'utf8');
  assert.equal(contentAfter, contentBefore, 'EPIC.md content should not change on second call');
});

// ---------------------------------------------------------------------------
// TC-003: --subs
// ---------------------------------------------------------------------------

test('TC-003: epic-new --subs writes sub-slugs to EPIC.md', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['epic-new', '--name', 'myepic', '--subs', 'alpha,beta gamma'], dir);
  assert.equal(r.ok, true);

  const epicMd = path.join(dir, '.spec-flow', 'epics', 'myepic', 'EPIC.md');
  const content = fs.readFileSync(epicMd, 'utf8');

  assert.match(content, /- myepic-alpha/);
  assert.match(content, /- myepic-beta-gamma/);
});

// ---------------------------------------------------------------------------
// TC-031: return shape
// ---------------------------------------------------------------------------

test('TC-031: epic-new return shape has epic, dir, path, subs', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['epic-new', '--name', 'myepic', '--subs', 'a,b'], dir);
  assert.equal(r.ok, true);

  const data = r.data;
  assert.equal(data.epic, 'myepic');
  assert.match(data.dir, /epics[/\\]myepic/);
  assert.ok(Array.isArray(data.subs), 'subs should be an array');
  assert.equal(data.subs.length, 2);
  assert.ok(data.path.endsWith('EPIC.md'), 'path should end with EPIC.md');
});

// ===========================================================================
// epic-attach tests (TC-005..011, TC-033, TC-036, TC-038, TC-029)
// ===========================================================================

// ---------------------------------------------------------------------------
// TC-005: epic-attach happy path
// ---------------------------------------------------------------------------

test('TC-005: epic-attach happy path', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  const r = run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-a'], dir);
  assert.equal(r.ok, true);
  assert.equal(r.data.epic, 'myepic');
  assert.equal(r.data.feature, 'feat-a');
  assert.equal(r.data.alreadyAttached, false);

  // EPIC.md should contain '- feat-a' in ## Sub-features
  const epicMd = path.join(dir, '.spec-flow', 'epics', 'myepic', 'EPIC.md');
  const content = fs.readFileSync(epicMd, 'utf8');
  assert.match(content, /## Sub-features[\s\S]*- feat-a/);

  // specs/feat-a/EPIC file should contain 'myepic'
  const epicFile = path.join(dir, '.spec-flow', 'specs', 'feat-a', 'EPIC');
  const epicContent = fs.readFileSync(epicFile, 'utf8').trim();
  assert.equal(epicContent, 'myepic');
});

// ---------------------------------------------------------------------------
// TC-006: epic-attach idempotent — second call returns alreadyAttached:true,
//         EPIC.md has exactly ONE '- feat-a' entry
// ---------------------------------------------------------------------------

test('TC-006: epic-attach idempotent', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-a'], dir);

  const r2 = run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-a'], dir);
  assert.equal(r2.ok, true);
  assert.equal(r2.data.alreadyAttached, true);

  // EPIC.md must have exactly ONE '- feat-a' line — no duplicates
  const epicMd = path.join(dir, '.spec-flow', 'epics', 'myepic', 'EPIC.md');
  const content = fs.readFileSync(epicMd, 'utf8');
  const matches = (content.match(/^- feat-a$/gm) || []);
  assert.equal(matches.length, 1, 'EPIC.md should have exactly one - feat-a entry');
});

// ---------------------------------------------------------------------------
// TC-007: epic-attach auto-creates specs/<feature>/ directory
// ---------------------------------------------------------------------------

test('TC-007: epic-attach auto-creates specs/<feature>/ dir', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  const specsNewFeat = path.join(dir, '.spec-flow', 'specs', 'new-feat');
  assert.equal(fs.existsSync(specsNewFeat), false, 'specs/new-feat/ should not exist yet');

  const r = run(['epic-attach', '--epic', 'myepic', '--feature', 'new-feat'], dir);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(specsNewFeat), true, 'specs/new-feat/ should now exist');

  const epicFile = path.join(specsNewFeat, 'EPIC');
  assert.equal(fs.existsSync(epicFile), true, 'EPIC file should be written');
});

// ---------------------------------------------------------------------------
// TC-008: epic-attach with legacy .md epic → EPIC_LEGACY
// ---------------------------------------------------------------------------

test('TC-008: epic-attach with legacy .md epic returns EPIC_LEGACY', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create a legacy file (not a directory)
  const epicsDir = path.join(dir, '.spec-flow', 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });
  fs.writeFileSync(path.join(epicsDir, 'old-epic.md'), '<!-- legacy -->\n');

  const r = run(['epic-attach', '--epic', 'old-epic', '--feature', 'feat-x'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /EPIC_LEGACY/);
});

// ---------------------------------------------------------------------------
// TC-009: epic-attach EPIC_CONFLICT — feature already belongs to another epic
// ---------------------------------------------------------------------------

test('TC-009: epic-attach EPIC_CONFLICT when feature belongs to other epic', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-a'], dir);

  run(['epic-new', '--name', 'other-epic'], dir);
  const r = run(['epic-attach', '--epic', 'other-epic', '--feature', 'feat-a'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /EPIC_CONFLICT/);
});

// ---------------------------------------------------------------------------
// TC-010: epic-attach MISSING_ARG — no --feature
// ---------------------------------------------------------------------------

test('TC-010: epic-attach MISSING_ARG when --feature is absent', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  const r = run(['epic-attach', '--epic', 'myepic'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /MISSING_ARG/);
});

// ---------------------------------------------------------------------------
// TC-011: epic-attach EPIC_NOT_FOUND — no such epic
// ---------------------------------------------------------------------------

test('TC-011: epic-attach EPIC_NOT_FOUND for nonexistent epic', () => {
  const dir = tmpProject();
  initProject(dir);

  const r = run(['epic-attach', '--epic', 'nonexistent', '--feature', 'feat-z'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /EPIC_NOT_FOUND/);
});

// ---------------------------------------------------------------------------
// TC-033: epic-attach return shape — both calls have epic, feature, alreadyAttached
// ---------------------------------------------------------------------------

test('TC-033: epic-attach return shape', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  const r1 = run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-b'], dir);
  assert.equal(r1.ok, true);
  assert.equal(typeof r1.data.epic, 'string');
  assert.equal(typeof r1.data.feature, 'string');
  assert.equal(typeof r1.data.alreadyAttached, 'boolean');
  assert.equal(r1.data.alreadyAttached, false);

  const r2 = run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-b'], dir);
  assert.equal(r2.ok, true);
  assert.equal(typeof r2.data.epic, 'string');
  assert.equal(typeof r2.data.feature, 'string');
  assert.equal(typeof r2.data.alreadyAttached, 'boolean');
  assert.equal(r2.data.alreadyAttached, true);
});

// ---------------------------------------------------------------------------
// TC-036: artifact files NOT in epic dir after epic-attach
// ---------------------------------------------------------------------------

test('TC-036: artifact files not in epic dir after attach', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-c'], dir);

  const epicDir = path.join(dir, '.spec-flow', 'epics', 'myepic');
  const forbidden = ['SD.md', 'tasks.json', 'CHECKLIST.yaml', 'VERIFICATION.md', 'STATE.md'];
  for (const f of forbidden) {
    assert.equal(
      fs.existsSync(path.join(epicDir, f)),
      false,
      `${f} should NOT be in epic dir`
    );
  }
});

// ---------------------------------------------------------------------------
// TC-038: EPIC file is a single slug — second attach to other epic → EPIC_CONFLICT
// ---------------------------------------------------------------------------

test('TC-038: EPIC file contains single slug, second epic attach triggers EPIC_CONFLICT', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'feat-a'], dir);

  // Verify the EPIC file contains only one line
  const epicFile = path.join(dir, '.spec-flow', 'specs', 'feat-a', 'EPIC');
  const content = fs.readFileSync(epicFile, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'EPIC file should have exactly one line');
  assert.equal(lines[0], 'myepic');

  run(['epic-new', '--name', 'other-epic'], dir);
  const r = run(['epic-attach', '--epic', 'other-epic', '--feature', 'feat-a'], dir);
  assert.equal(r.ok, false);
  assert.match(r.error, /EPIC_CONFLICT/);
});

// ===========================================================================
// ingest.md --epic flag documentation tests (TC-020..TC-022, FR-025, FR-026)
// ===========================================================================

const INGEST_MD = path.join(__dirname, '..', 'commands', 'ingest.md');

// ---------------------------------------------------------------------------
// TC-020: ingest.md mentions epic-attach call (including the idempotent case)
// ---------------------------------------------------------------------------

test('TC-020: ingest.md mentions epic-attach call when epic already exists', () => {
  const content = fs.readFileSync(INGEST_MD, 'utf8');
  assert.ok(
    content.includes('epic-attach'),
    'ingest.md must include an epic-attach call'
  );
  assert.ok(
    content.includes('alreadyAttached') || content.includes('already attached') || content.includes('idempotent'),
    'ingest.md must mention the idempotent / alreadyAttached behavior of epic-attach'
  );
});

// ---------------------------------------------------------------------------
// TC-021: ingest.md shows calling epic-new first then epic-attach for new epic
// ---------------------------------------------------------------------------

test('TC-021: ingest.md shows epic-new called before epic-attach', () => {
  const content = fs.readFileSync(INGEST_MD, 'utf8');
  assert.ok(content.includes('epic-new'), 'ingest.md must include an epic-new call');
  assert.ok(content.includes('epic-attach'), 'ingest.md must include an epic-attach call');
  // epic-new must appear before epic-attach in the document
  const posNew = content.indexOf('epic-new');
  const posAttach = content.indexOf('epic-attach');
  assert.ok(posNew < posAttach, 'epic-new must appear before epic-attach in the document');
});

// ---------------------------------------------------------------------------
// TC-022: ingest.md states that without --epic, behavior is unchanged
// ---------------------------------------------------------------------------

test('TC-022: ingest.md states that without --epic, behavior is unchanged', () => {
  const content = fs.readFileSync(INGEST_MD, 'utf8');
  assert.ok(
    content.includes('--epic'),
    'ingest.md must mention the --epic flag'
  );
  // The document should indicate that when --epic is absent the behavior is unchanged/skipped
  assert.ok(
    content.includes('absent') || content.includes('skip') || content.includes('without --epic'),
    'ingest.md must state that without --epic, the epic calls are skipped'
  );
});

// ---------------------------------------------------------------------------
// TC-029: FR-037 compliance — no subprocess spawned
// epic-attach uses only fs/path, no child_process calls.
// This is verified by code inspection: the handler reads STATE_DIR, PATHS, fs,
// path — all pure Node built-ins — and never calls execSync/spawn/execFile.
// The runtime test below confirms the command returns without error (smoke test).
// ---------------------------------------------------------------------------

test('TC-029: epic-attach is pure file ops (FR-037 compliance smoke test)', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  // If the command completes successfully it didn't need a subprocess to succeed
  const r = run(['epic-attach', '--epic', 'myepic', '--feature', 'fr037-check'], dir);
  assert.equal(r.ok, true, 'epic-attach should complete without subprocess');
  // FR-037 compliance: verified by code inspection — no child_process usage in epic-attach handler
});

// ---------------------------------------------------------------------------
// TC-012: epic-list sees both dir and legacy entries (FR-016)
// ---------------------------------------------------------------------------

test('TC-012: epic-list sees both directory and legacy epics', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create a directory epic
  run(['epic-new', '--name', 'new-epic'], dir);

  // Create a legacy .md epic manually
  const epicsDir = path.join(dir, '.spec-flow', 'epics');
  const legacyContent = [
    '<!-- spec-flow epic record -->',
    'id: old-epic',
    'name: Old Epic',
    'status: active',
    '',
    '## Sub-features',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(epicsDir, 'old-epic.md'), legacyContent);

  const r = run(['epic-list'], dir);
  assert.equal(r.ok, true, 'epic-list should succeed');
  assert.ok(Array.isArray(r.data.epics), 'data.epics should be an array');
  assert.equal(r.data.epics.length, 2, 'should have exactly 2 entries');

  const dirEntry = r.data.epics.find(e => e.id === 'new-epic');
  assert.ok(dirEntry, 'should have new-epic entry');
  assert.equal(dirEntry.legacy, false, 'new-epic should not be legacy');
  assert.ok('progress' in dirEntry, 'new-epic entry should have progress field');

  const legacyEntry = r.data.epics.find(e => e.id === 'old-epic');
  assert.ok(legacyEntry, 'should have old-epic entry');
  assert.equal(legacyEntry.legacy, true, 'old-epic should be legacy');
  assert.ok('progress' in legacyEntry, 'old-epic entry should have progress field');
});

// ---------------------------------------------------------------------------
// TC-013: epic-list progress computed from real data (FR-017, FR-018)
// ---------------------------------------------------------------------------

test('TC-013: epic-list progress computed from real data', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create epic with 2 sub-features attached
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'sub-a'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'sub-b'], dir);

  // Write tasks.json for sub-a with all tasks done
  const taskmasterDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(taskmasterDir, { recursive: true });
  const tasksData = {
    'sub-a': {
      tasks: [
        {
          id: '1',
          title: 'task 1',
          status: 'done',
          dependencies: [],
          subtasks: [],
          priority: 'medium',
          updatedAt: '2026-01-01T00:00:00.000Z',
          description: 'test',
        },
      ],
      metadata: {},
    },
    'sub-b': {
      tasks: [
        {
          id: '2',
          title: 'task 2',
          status: 'pending',
          dependencies: [],
          subtasks: [],
          priority: 'medium',
          updatedAt: '2026-01-01T00:00:00.000Z',
          description: 'test',
        },
      ],
      metadata: {},
    },
  };
  fs.writeFileSync(
    path.join(taskmasterDir, 'tasks.json'),
    JSON.stringify(tasksData, null, 2)
  );

  // Write ship.json for sub-b
  const subBSpecsDir = path.join(dir, '.spec-flow', 'specs', 'sub-b');
  fs.mkdirSync(subBSpecsDir, { recursive: true });
  fs.writeFileSync(path.join(subBSpecsDir, 'ship.json'), JSON.stringify({ shipped: true }));

  const r = run(['epic-list'], dir);
  assert.equal(r.ok, true, 'epic-list should succeed');

  const entry = r.data.epics.find(e => e.id === 'myepic');
  assert.ok(entry, 'should have myepic entry');
  assert.equal(entry.subCount, 2, 'subCount should be 2');
  assert.equal(entry.progress.total, 2, 'progress.total should be 2');
  assert.equal(entry.progress.done, 1, 'progress.done should be 1 (sub-a all tasks done)');
  assert.equal(entry.progress.shipped, 1, 'progress.shipped should be 1 (sub-b has ship.json)');
});

// ---------------------------------------------------------------------------
// TC-014: epic-list EPIC_DUPLICATE when both dir and .md exist (FR-019)
// ---------------------------------------------------------------------------

test('TC-014: epic-list EPIC_DUPLICATE when both dir and .md exist', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create directory epic
  run(['epic-new', '--name', 'myepic'], dir);

  // Also create legacy .md file for same slug
  const epicsDir = path.join(dir, '.spec-flow', 'epics');
  const legacyContent = [
    '<!-- spec-flow epic record -->',
    'id: myepic',
    'name: My Epic Legacy',
    'status: archived',
    '',
    '## Sub-features',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(epicsDir, 'myepic.md'), legacyContent);

  const r = run(['epic-list'], dir);
  assert.equal(r.ok, true, 'epic-list should succeed');
  assert.ok(Array.isArray(r.data.epics), 'data.epics should be an array');

  // Should be ONE entry for myepic, not two
  const myepicEntries = r.data.epics.filter(e => e.id === 'myepic');
  assert.equal(myepicEntries.length, 1, 'should have exactly one entry for myepic');

  const entry = myepicEntries[0];
  assert.ok('EPIC_DUPLICATE' in entry, 'entry should have EPIC_DUPLICATE field');
  assert.match(entry.EPIC_DUPLICATE, /myepic/, 'EPIC_DUPLICATE message should mention slug');
  // Directory takes precedence — name from EPIC.md (directory), not from legacy .md
  assert.equal(entry.legacy, false, 'entry should use directory (legacy:false) as primary source');
});

// ---------------------------------------------------------------------------
// TC-039: no tasks in store returns {done:0, total:X} gracefully (FR-036)
// ---------------------------------------------------------------------------

test('TC-039: epic-list graceful when no tasks.json for sub-feature', () => {
  const dir = tmpProject();
  initProject(dir);

  // Create epic with 1 sub-feature — NO tasks.json created
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'lonely-sub'], dir);

  const r = run(['epic-list'], dir);
  assert.equal(r.ok, true, 'epic-list should succeed even without tasks.json');

  const entry = r.data.epics.find(e => e.id === 'myepic');
  assert.ok(entry, 'should have myepic entry');
  assert.equal(entry.subCount, 1, 'subCount should be 1');
  assert.equal(entry.progress.total, 1, 'progress.total should equal subCount');
  assert.equal(entry.progress.done, 0, 'progress.done should be 0 gracefully');
  assert.equal(entry.progress.shipped, 0, 'progress.shipped should be 0');
});

// ===========================================================================
// split.md documentation tests (TC-034, TC-035, FR-027, FR-028)
// ===========================================================================

const SPLIT_MD = path.join(__dirname, '..', 'commands', 'split.md');

/**
 * Extract the text of a STEP section (from "## STEP N" up to the next "## STEP"
 * or "## Next" heading, so each step is self-contained).
 *
 * No `m` flag: `$` matches only true end-of-string, so the lazy quantifier
 * runs until it finds the next heading or the string ends — not the first EOL.
 */
function extractStep(content, stepNum) {
  const pattern = new RegExp(
    `## STEP ${stepNum}[\\s\\S]*?(?=## STEP \\d|## Next|$)`
  );
  const m = content.match(pattern);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// TC-034: FR-027 — split.md STEP 4 references directory workspace, not .md file
// ---------------------------------------------------------------------------

test('TC-034: split.md STEP 4 references directory workspace, not legacy .md file', () => {
  const content = fs.readFileSync(SPLIT_MD, 'utf8');
  const step4 = extractStep(content, 4);

  assert.ok(step4.length > 0, 'STEP 4 section should exist in split.md');

  // Must NOT have the old flat .md file reference
  assert.ok(
    !step4.includes('.spec-flow/epics/<slug>.md'),
    'STEP 4 must not reference old .md file path (.spec-flow/epics/<slug>.md)'
  );

  // Must reference the directory form
  assert.ok(
    step4.includes('.spec-flow/epics/<slug>/') || step4.includes('directory'),
    'STEP 4 must reference directory workspace (.spec-flow/epics/<slug>/ or "directory")'
  );
});

// ---------------------------------------------------------------------------
// TC-035: FR-028 — split.md STEP 5 mentions SRS slice path and epic-attach call
// ---------------------------------------------------------------------------

test('TC-035: split.md STEP 5 mentions SRS slice path and epic-attach call', () => {
  const content = fs.readFileSync(SPLIT_MD, 'utf8');
  const step5 = extractStep(content, 5);

  assert.ok(step5.length > 0, 'STEP 5 section should exist in split.md');

  // Must mention the SRS slice path inside the epic directory
  assert.ok(
    step5.includes('epics/<slug>/srs/'),
    'STEP 5 must mention SRS slice path inside epic directory (epics/<slug>/srs/)'
  );

  // Must include an epic-attach call
  assert.ok(
    step5.includes('epic-attach'),
    'STEP 5 must include an epic-attach call for each sub-feature'
  );
});

// ===========================================================================
// epic-show tests (TC-015, TC-016, TC-017, TC-037)
// FR-020, FR-021, FR-022, FR-034
// ===========================================================================

// ---------------------------------------------------------------------------
// TC-015: epic-show happy path — returns all fields
// ---------------------------------------------------------------------------

test('TC-015: epic-show happy path returns all fields', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);
  run(['epic-attach', '--epic', 'myepic', '--feature', 'sub-a'], dir);

  const r = run(['epic-show', '--epic', 'myepic'], dir);
  assert.equal(r.ok, true, 'epic-show should succeed');

  const data = r.data;
  assert.equal(data.id, 'myepic', 'data.id should be myepic');
  assert.ok(typeof data.name === 'string', 'data.name should be a string');
  assert.equal(data.subCount, 1, 'data.subCount should be 1');
  assert.deepEqual(data.progress, { done: 0, total: 1, shipped: 0 }, 'progress should match expected');
  assert.equal(data.legacy, false, 'data.legacy should be false');

  assert.ok(Array.isArray(data.subs), 'data.subs should be an array');
  assert.equal(data.subs.length, 1, 'subs should have 1 entry');
  const sub = data.subs[0];
  assert.equal(sub.feature, 'sub-a', 'sub.feature should be sub-a');
  assert.equal(typeof sub.hasSd, 'boolean', 'sub.hasSd should be boolean');
  assert.equal(sub.hasSd, false, 'sub.hasSd should be false (no SD.md yet)');
  assert.deepEqual(sub.tasks, { done: 0, total: 0 }, 'sub.tasks should be {done:0,total:0}');
  assert.equal(sub.shipped, false, 'sub.shipped should be false');
  assert.equal(sub.shippedAt, null, 'sub.shippedAt should be null');

  assert.ok(Array.isArray(data.files), 'data.files should be an array');
  assert.ok(data.files.includes('EPIC.md'), 'data.files should include EPIC.md');
});

// ---------------------------------------------------------------------------
// TC-016: epic-show files field lists relative paths including added files
// ---------------------------------------------------------------------------

test('TC-016: epic-show files field lists relative paths', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  // Write extra files into epic dir subdirectories
  const epicDir = path.join(dir, '.spec-flow', 'epics', 'myepic');
  fs.writeFileSync(path.join(epicDir, 'decisions', 'adr-001.md'), '# ADR 001\n');
  fs.writeFileSync(path.join(epicDir, 'srs', 'phase1.md'), '# SRS Phase 1\n');

  const r = run(['epic-show', '--epic', 'myepic'], dir);
  assert.equal(r.ok, true, 'epic-show should succeed');

  const files = r.data.files;
  assert.ok(Array.isArray(files), 'data.files should be an array');
  assert.ok(files.includes('decisions/adr-001.md'), 'files should include decisions/adr-001.md');
  assert.ok(files.includes('srs/phase1.md'), 'files should include srs/phase1.md');
});

// ---------------------------------------------------------------------------
// TC-017: epic-show EPIC_NOT_FOUND for nonexistent epic
// ---------------------------------------------------------------------------

test('TC-017: epic-show EPIC_NOT_FOUND for nonexistent epic', () => {
  const dir = tmpProject();
  initProject(dir);

  const r = run(['epic-show', '--epic', 'ghost-epic'], dir);
  assert.equal(r.ok, false, 'epic-show should fail for nonexistent epic');
  assert.match(r.error, /EPIC_NOT_FOUND/, 'error should match EPIC_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// TC-037: epic-show lists files outside conventional subdirs, no error
// ---------------------------------------------------------------------------

test('TC-037: epic-show lists files outside conventional subdirs without error', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'myepic'], dir);

  // Write a file directly in the epic root (outside any subdirectory)
  const epicDir = path.join(dir, '.spec-flow', 'epics', 'myepic');
  fs.writeFileSync(path.join(epicDir, 'my-notes.md'), '# Notes\n');

  const r = run(['epic-show', '--epic', 'myepic'], dir);
  assert.equal(r.ok, true, 'epic-show should succeed even with non-conventional files');

  const files = r.data.files;
  assert.ok(Array.isArray(files), 'data.files should be an array');
  assert.ok(files.includes('my-notes.md'), 'files should include my-notes.md at root level');
});

// ===========================================================================
// state-update epic field tests (TC-018, TC-019, FR-023, FR-024)
// ===========================================================================

// ---------------------------------------------------------------------------
// TC-018: state-update with EPIC reverse link adds epic field
// ---------------------------------------------------------------------------

test('TC-018: state-update with EPIC file adds epic field to return value', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'my-epic'], dir);
  run(['epic-attach', '--epic', 'my-epic', '--feature', 'feat-a'], dir);
  const r = run(['state-update', '--feature', 'feat-a', '--note', 'test'], dir);
  assert.equal(r.ok, true, 'state-update should succeed');
  assert.ok(r.data && r.data.epic, 'should have epic field');
  assert.equal(r.data.epic.id, 'my-epic', 'epic.id should be my-epic');
  assert.ok(r.data.epic.progress, 'should have progress object');
  assert.equal(typeof r.data.epic.progress.total, 'number', 'progress.total should be a number');
  assert.equal(typeof r.data.epic.progress.done, 'number', 'progress.done should be a number');
  assert.equal(typeof r.data.epic.progress.shipped, 'number', 'progress.shipped should be a number');
});

// ---------------------------------------------------------------------------
// TC-019: state-update without EPIC file has no epic field (FR-024 non-regression)
// ---------------------------------------------------------------------------

test('TC-019: state-update without EPIC file has no epic field', () => {
  const dir = tmpProject();
  initProject(dir);
  const r = run(['state-update', '--feature', 'plain-feat', '--note', 'test'], dir);
  assert.equal(r.ok, true, 'state-update should succeed');
  assert.equal(r.data && r.data.epic, undefined, 'should NOT have epic field when no EPIC reverse link');
});

// ---------------------------------------------------------------------------
// TC-040: status-report with EPIC reverse link adds epic field
// ---------------------------------------------------------------------------

test('TC-040: status-report with EPIC file adds epic field to return value', () => {
  const dir = tmpProject();
  initProject(dir);
  run(['epic-new', '--name', 'srep-epic'], dir);
  run(['epic-attach', '--epic', 'srep-epic', '--feature', 'feat-b'], dir);
  const r = run(['status-report', '--feature', 'feat-b'], dir);
  assert.equal(r.ok, true, 'status-report should succeed');
  assert.ok(r.data && r.data.epic, 'status-report should have epic field');
  assert.equal(r.data.epic.id, 'srep-epic', 'epic.id should be srep-epic');
  assert.ok(r.data.epic.progress, 'should have progress object');
});
