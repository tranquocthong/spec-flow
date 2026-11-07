/**
 * sd-slice — the per-task SD cut handed to hybrid-executor instead of the whole SD.
 *   - lib/sd-slice.cjs sliceSd(): which lines survive, verbatim
 *   - `flow-tools.cjs sd-slice`: id resolution from task text + trace links, --out
 *
 * Run:  node --test test/sd-slice.test.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sliceSd, idsFromText } = require('../lib/sd-slice.cjs');

const ENGINE = path.join(__dirname, '..', 'bin', 'flow-tools.cjs');

const SD = [
  '# Solution Design: demo',
  '',
  '## 5. Requirements',
  '',
  '### 5.1 Functional Requirements',
  '',
  '| ID | Requirement | Priority |',
  '| --- | --- | --- |',
  '| FR-001 | Create place | Must Have |',
  '| FR-002 | Delete place | Must Have |',
  '| FR-003 | List places | Should Have |',
  '',
  '### 5.2 Non-Functional Requirements',
  '',
  '| ID | Category | Requirement | Target |',
  '| --- | --- | --- | --- |',
  '| NFR-001 | Reliability | FR-001 to FR-003 have tests | 100% |',
  '',
  '## 9. API Design',
  '',
  '### 9.2 API Endpoints',
  '',
  '#### `POST /api/v1/places`',
  '',
  'Implements FR-001.',
  '',
  '| Field | Type |',
  '| --- | --- |',
  '| name | string |',
  '',
  '#### `DELETE /api/v1/places/{id}`',
  '',
  'Implements FR-002.',
  '',
  '### 9.4 Sequence Diagrams',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Note over A: FR-001 create',
  '  A->>B: insert',
  '```',
  '',
  '## 10. Internal Process Design',
  '',
  'Rule: FR-001 rejects a duplicate name.',
  'Rule: FR-003 pages by 20.',
  '',
  '## 12. Error Handling',
  '',
  '### 12.2 Domain Error Codes',
  '',
  '| Error Code | Trigger | HTTP |',
  '| --- | --- | --- |',
  '| PLACE_DUPLICATE | name taken | 409 |',
  '| PLACE_NOT_FOUND | unknown id | 404 |',
  '',
  '## 13. Testing Strategy',
  '',
  '### 13.2 Test Cases',
  '',
  '| TC ID | Flow | Test Case | Expected Result | FR | Level |',
  '| --- | --- | --- | --- | --- | --- |',
  '| TC-001 | Create | valid | 201 | FR-001 | it |',
  '| TC-002 | Create | duplicate | 409 PLACE_DUPLICATE | FR-001 | unit |',
  '| TC-003 | Delete | unknown | 404 PLACE_NOT_FOUND | FR-002 | unit |',
  '| TC-004 | Reliability | suite green | pass | NFR-001 | unit |',
  '',
].join('\n');

test('sliceSd: keeps the FR row, its TC rows (via the FR column) and the error codes those rows name — nothing else', () => {
  const s = sliceSd(SD, ['FR-001']);
  const md = s.markdown;
  assert.match(md, /\| FR-001 \| Create place \| Must Have \|/);
  assert.doesNotMatch(md, /FR-002 \| Delete place/);
  assert.match(md, /\| ID \| Requirement \| Priority \|/, 'table header travels with its rows');
  assert.match(md, /\| TC-001 \|/);
  assert.match(md, /\| TC-002 \|/);
  assert.doesNotMatch(md, /\| TC-003 \|/);
  assert.deepEqual(s.errorCodes, ['PLACE_DUPLICATE']);
  assert.doesNotMatch(md, /PLACE_NOT_FOUND/);
  assert.deepEqual(s.missing, []);
  assert.ok(s.ids.includes('TC-001') && s.ids.includes('TC-002'), 'TC rows naming FR-001 joined the set');
});

test('sliceSd: a leaf block (#### endpoint) that names the FR comes whole; a sibling endpoint does not', () => {
  const md = sliceSd(SD, ['FR-001']).markdown;
  assert.match(md, /#### `POST \/api\/v1\/places`/);
  assert.match(md, /\| name \| string \|/, 'the endpoint field table rides along with its block');
  assert.doesNotMatch(md, /DELETE \/api\/v1\/places/);
});

test('sliceSd: prose lines naming the FR keep their heading trail; fenced diagrams are never cut line by line', () => {
  const md = sliceSd(SD, ['FR-001']).markdown;
  assert.match(md, /## 10\. Internal Process Design\n\nRule: FR-001 rejects a duplicate name\./);
  assert.doesNotMatch(md, /FR-003 pages/);
  assert.doesNotMatch(md, /Note over A/, 'a mermaid line is not prose — the outline points at 9.4 instead');
});

test('sliceSd: an NFR row citing a range is kept but does not drag its own TCs in', () => {
  const s = sliceSd(SD, ['FR-001']);
  assert.match(s.markdown, /\| NFR-001 \|/, 'NFR row mentions FR-001 → kept');
  assert.doesNotMatch(s.markdown, /\| TC-004 \|/);
  assert.ok(!s.ids.includes('NFR-001'));
});

test('sliceSd: ids absent from the SD are reported as missing', () => {
  const s = sliceSd(SD, ['FR-001', 'FR-099']);
  assert.deepEqual(s.missing, ['FR-099']);
});

test('sliceSd: outline carries 1-based line ranges for every section up to level 3', () => {
  const s = sliceSd(SD, ['FR-002']);
  const lines = SD.split('\n');
  const h94 = s.outline.find((h) => h.title === '9.4 Sequence Diagrams');
  assert.ok(h94);
  assert.equal(lines[h94.from - 1], '### 9.4 Sequence Diagrams');
  assert.ok(!s.outline.some((h) => h.level > 3));
});

test('idsFromText: FR/TC/NFR ids, uppercased and deduped', () => {
  assert.deepEqual(idsFromText('implements fr-001 and FR-001; covers TC-12, NFR-2'), ['FR-001', 'TC-12', 'NFR-2']);
});

// ---- the CLI command -------------------------------------------------------

function run(args, cwd) {
  let out;
  try { out = execFileSync('node', [ENGINE, ...args], { cwd, encoding: 'utf8' }); }
  catch (e) { if (e.stdout) out = String(e.stdout); else throw e; }
  return JSON.parse(out.trim().split('\n').pop());
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sd-slice-'));
  assert.equal(run(['init-project', '--stack', 'node'], dir).ok, true);
  const sdDir = path.join(dir, '.spec-flow', 'specs', 'demo');
  fs.mkdirSync(sdDir, { recursive: true });
  fs.writeFileSync(path.join(sdDir, 'SD.md'), SD);
  assert.equal(run(['trace-build', '--sd', path.join(sdDir, 'SD.md'), '--feature', 'demo'], dir).ok, true);
  const tmDir = path.join(dir, '.taskmaster', 'tasks');
  fs.mkdirSync(tmDir, { recursive: true });
  fs.writeFileSync(path.join(tmDir, 'tasks.json'), JSON.stringify({
    demo: { tasks: [
      { id: 1, title: 'Create place endpoint', details: 'Implements FR-001.', status: 'pending' },
      { id: 2, title: 'Delete place', status: 'pending',
        subtasks: [{ id: 1, title: 'Handler for FR-002' }, { id: 2, title: 'Repo for FR-002' }] },
      { id: 3, title: 'Bump Go toolchain', status: 'pending' },
    ] },
  }, null, 2));
  return dir;
}

test('sd-slice --task: ids from the task text, TCs from the trace, slice + outline in markdown', () => {
  const dir = seed();
  const r = run(['sd-slice', '--feature', 'demo', '--task', '1'], dir);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.data.ids.includes('FR-001'));
  assert.ok(r.data.via.includes('task text'));
  assert.match(r.data.markdown, /\| FR-001 \| Create place/);
  assert.match(r.data.markdown, /## SD outline/);
  assert.match(r.data.markdown, /- L\d+-\d+ 9\. API Design/);
  assert.ok(r.data.sliceLines < r.data.sdLines + 40);
  assert.deepEqual(r.data.warnings, []);
});

test('sd-slice: a trace-link stored with a comma list in --fr is split, not reported as one unknown id', () => {
  const dir = seed();
  // Field case: `trace-link --fr "FR-001,FR-002"` stores ONE link whose from is the whole list.
  run(['trace-link', '--task', '3', '--feature', 'demo', '--fr', 'FR-001,FR-002', '--files', 'go.mod'], dir);
  const r = run(['sd-slice', '--feature', 'demo', '--task', '3'], dir);
  assert.equal(r.ok, true);
  assert.ok(r.data.ids.includes('FR-001') && r.data.ids.includes('FR-002'));
  assert.ok(!r.data.ids.some((i) => i.includes(',')), 'no glued id survives');
  assert.deepEqual(r.data.warnings, []);
});

test('sd-slice --task <parent>.<sub>: reads the subtask text', () => {
  const dir = seed();
  const r = run(['sd-slice', '--feature', 'demo', '--task', '2.1'], dir);
  assert.equal(r.ok, true);
  assert.ok(r.data.ids.includes('FR-002'));
  assert.match(r.data.markdown, /PLACE_NOT_FOUND/, 'TC-003 → its error code');
});

test('sd-slice: a chore task naming no id returns the outline and says so', () => {
  const dir = seed();
  const r = run(['sd-slice', '--feature', 'demo', '--task', '3'], dir);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.ids, []);
  assert.match(r.data.markdown, /No FR\/TC id found/);
  assert.match(r.data.markdown, /## SD outline/);
});

test('sd-slice --ids + --out: writes the slice file; unknown ids are warned', () => {
  const dir = seed();
  const out = path.join(dir, 'slice.md');
  const r = run(['sd-slice', '--feature', 'demo', '--ids', 'FR-003,FR-077', '--out', out], dir);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(out, 'utf8'), r.data.markdown);
  assert.match(r.data.warnings[0], /IDS_NOT_IN_SD: FR-077/);
});

test('sd-slice: unknown task id → ERR_TASK_NOT_FOUND', () => {
  const dir = seed();
  const r = run(['sd-slice', '--feature', 'demo', '--task', '42'], dir);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /ERR_TASK_NOT_FOUND/);
});

// ---- doc contract: the flow actually hands the slice over -------------------

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('commands/phase.md step 2 spawns the executor with sd-slice output, not the SD path', () => {
  const md = read('commands/phase.md');
  const step2 = md.slice(md.indexOf('2. **Spawn hybrid-executor**'), md.indexOf('3. **Record the disk facts'));
  assert.match(step2, /sd-slice --feature <feature> --task <id>/);
  assert.match(step2, /data\.markdown/);
  assert.match(step2, /IDS_NOT_IN_SD/);
  assert.match(step2, /Analogs:/);
  assert.match(step2, /shared test resources/i);
});

test('agents/hybrid-executor.md reads the slice and opens other SD sections by line range only', () => {
  const md = read('agents/hybrid-executor.md');
  assert.match(md, /\*\*SD slice\*\*/);
  assert.match(md, /do not read the whole SD/);
  assert.match(md, /line range/);
  assert.match(md, /`Analogs:`/);
});

test('commands/bug.md STEP 4a pastes an sd-slice for the impacted ids', () => {
  assert.match(read('commands/bug.md'), /sd-slice --feature <feature> --ids/);
});

// ---- large outputs survive a pipe -----------------------------------------
// Both entrypoints used to process.exit() right after an async write to a pipe,
// so anything above 64 KB reached the caller (an agent's Bash tool) cut mid-JSON.

const { spawn } = require('node:child_process');

/** Run a bin through a real pipe; resolve with stdout bytes. */
function pipeRun(bin, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [bin, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function bigSd(rows) {
  const filler = 'x'.repeat(200);
  const fr = Array.from({ length: rows }, (_, i) => `| FR-${String(i + 1).padStart(3, '0')} | Requirement ${filler} | Must Have |`);
  return ['# SD: big', '', '## 5.1 Functional Requirements', '', '| ID | Requirement | Priority |', '| --- | --- | --- |', ...fr, ''].join('\n');
}

test('flow-tools: a result above 64 KB arrives whole through a pipe', async () => {
  const dir = seed();
  fs.writeFileSync(path.join(dir, '.spec-flow', 'specs', 'demo', 'SD.md'), bigSd(600));
  const ids = Array.from({ length: 600 }, (_, i) => `FR-${String(i + 1).padStart(3, '0')}`).join(',');
  const out = await pipeRun(ENGINE, ['sd-slice', '--feature', 'demo', '--ids', ids], dir);
  assert.ok(Buffer.byteLength(out) > 65536 * 2, `output is large enough to have been cut (${Buffer.byteLength(out)} bytes)`);
  const r = JSON.parse(out);
  assert.equal(r.ok, true);
  assert.match(r.data.markdown, /FR-600/);
});

test('task-master: a parse-prd GenerationSpec above 64 KB arrives whole through a pipe', async () => {
  const dir = seed();
  const sd = path.join(dir, 'big-sd.md');
  fs.writeFileSync(sd, bigSd(600));
  const bin = path.join(__dirname, '..', 'bin', 'task-master');
  const out = await pipeRun(bin, ['parse-prd', '--input', sd, '--tag', 'probe'], dir, { SPEC_FLOW_HOST_AGENT: '1' });
  assert.ok(Buffer.byteLength(out) > 65536 * 2);
  const spec = JSON.parse(out);
  assert.match(spec.inputContent, /FR-600/);
});
