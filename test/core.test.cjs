/**
 * Unit tests for lib/core.cjs — the shared infra + SRS/SD parsers (no command logic).
 * These require the module DIRECTLY (not via the CLI) to exercise the pure parsing/
 * generation functions in isolation. Complements flow-tools.test.cjs (CLI integration).
 *
 * Run:  node --test test/core.test.cjs   (or: node --test test/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core.cjs');

// ---------------------------------------------------------------------------
// Result helpers + tiny utils
// ---------------------------------------------------------------------------

test('ok/err produce the Result contract', () => {
  assert.deepEqual(core.ok({ a: 1 }), { ok: true, data: { a: 1 } });
  assert.deepEqual(core.err('BOOM'), { ok: false, error: 'BOOM' });
});

test('slugify: lowercases, hyphenates, trims, caps length, falls back', () => {
  assert.equal(core.slugify('Outbox CDC Circuit Breaker'), 'outbox-cdc-circuit-breaker');
  assert.equal(core.slugify('  Foo / Bar!! '), 'foo-bar');
  assert.equal(core.slugify(''), 'feature');
  assert.equal(core.slugify('---'), 'feature');
  assert.ok(core.slugify('x'.repeat(200)).length <= 60);
});

test('pad3 zero-pads to 3', () => {
  assert.equal(core.pad3(1), '001');
  assert.equal(core.pad3(42), '042');
  assert.equal(core.pad3(1234), '1234');
});

test('parseArgs: --key value, positionals, trailing boolean flag', () => {
  // A flag is boolean only when last or followed by another --flag; `--force X` would
  // bind X as the value. Here --force is last → true; `pos` is a positional.
  assert.deepEqual(core.parseArgs(['--sd', 'X.md', 'pos', '--force']), { _: ['pos'], sd: 'X.md', force: true });
  assert.deepEqual(core.parseArgs([]), { _: [] });
});

test('moscowFor: first=Must, middle=Should, tail=Could', () => {
  assert.equal(core.moscowFor(0, 4), 'Must Have');
  assert.equal(core.moscowFor(1, 4), 'Should Have');
  assert.equal(core.moscowFor(3, 4), 'Could Have');
});

test('routeFor: complexity score → adaptive route', () => {
  assert.equal(core.routeFor(2), 'fast');
  assert.equal(core.routeFor(5), 'expand');
  assert.equal(core.routeFor(9), 'deep');
});

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

test('parseAllTables: extracts headers + rows, skips the --- separator', () => {
  const md = [
    '| A | B | C |',
    '| --- | --- | --- |',
    '| 1 | 2 | 3 |',
    '| x | y | z |',
  ];
  const tables = core.parseAllTables(md);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['A', 'B', 'C']);
  assert.equal(tables[0].rows.length, 2);
  assert.deepEqual(tables[0].rows[0], ['1', '2', '3']);
});

test('splitRow: `\\|` is cell text, not a column separator', () => {
  // An FR whose Requirement names an enum: the pipes belong to the VALUE. Split on
  // them and every later column shifts — route() read the priority out of the
  // Source cell and trace-build stored a truncated requirement.
  const row = '| FR-002 | status must be one of `pending\\|done\\|failed` | Must Have | BL-03 |';
  assert.deepEqual(core.splitRow(row), [
    'FR-002',
    'status must be one of `pending|done|failed`',
    'Must Have',
    'BL-03',
  ], 'four cells, and the real `|` (U+007C) is restored — never the backslash');

  // Unescaped pipes still separate (a hand-written SD stays parseable, just wrong-shaped).
  assert.equal(core.splitRow('| a | b|c | d |').length, 4);
  // Escape at the very end of the last cell: the trailing `|` is still the row terminator.
  assert.deepEqual(core.splitRow('| a | ends with \\| |'), ['a', 'ends with |']);
});

test('mdCell → splitRow round-trips a pipe-bearing value losslessly', () => {
  const payload = 'sha256(merchantId|orderId|amount)';
  const cell = core.mdCell(payload);
  assert.equal(cell, 'sha256(merchantId\\|orderId\\|amount)', 'escaped on write');
  assert.deepEqual(core.splitRow(`| FR-001 | ${cell} | Must Have | BL-01 |`)[1], payload, 'unescaped on read');
  // Already-escaped input must not double-escape (an SRS author may write `\|` themselves;
  // splitRow hands us the plain value, so a re-render stays stable).
  assert.equal(core.mdCell(core.splitRow(`| ${cell} |`)[0]), cell);
  // Newlines would break the row entirely.
  assert.equal(core.mdCell('two\nlines'), 'two lines');
  assert.equal(core.mdCell(null), '');
});

test('resolveCols: header names win over position, fallback when absent', () => {
  // 6-col enriched §13.2 — position 3 is Input / Condition, NOT Expected.
  const rich = { headers: ['TC ID', 'Flow', 'Test Case', 'Input / Condition', 'Expected Result', 'FR'], rows: [] };
  const c = core.resolveCols(rich, { id: [/tc\s*id/i, 0], text: [/test\s*case/i, 2], expected: [/expected/i, 3] });
  assert.equal(c.expected, 4);
  // 4-col skeleton — the same spec falls back to its positional index.
  const skeleton = { headers: ['TC ID', 'Flow', 'Test Case', 'Expected'], rows: [] };
  assert.equal(core.resolveCols(skeleton, { expected: [/expected/i, 3] }).expected, 3);
  // Reordered columns resolve by name.
  const swapped = { headers: ['Requirement', 'ID', 'Priority (MoSCoW)', 'Source'], rows: [] };
  const s = core.resolveCols(swapped, { id: [/\bid\b/i, 0], text: [/requirement/i, 1], priority: [/priority|moscow/i, 2] });
  assert.deepEqual([s.id, s.text, s.priority], [1, 0, 2]);
  // No headers at all → pure fallback, never -1 (which would read undefined cells).
  assert.deepEqual(core.resolveCols(null, { a: [/nope/i, 0], b: [/nah/i, 1] }), { a: 0, b: 1 });
});

test('tableShapeWarnings: flags rows that lost the header column count', () => {
  const table = {
    headers: ['ID', 'Requirement', 'Priority', 'Source'],
    rows: [
      ['FR-001', 'fine', 'Must Have', 'BL-01'],
      ['FR-002', 'status in pending', 'done', 'failed', 'Must Have', 'BL-02'], // unescaped `|`
    ],
  };
  const w = core.tableShapeWarnings(table, 'SD §5.1 FR table');
  assert.equal(w.length, 1);
  assert.match(w[0], /SD §5\.1 FR table/);
  assert.match(w[0], /FR-002 \(6 cells\)/, 'names the offending row and its actual cell count');
  assert.match(w[0], /unescaped/, 'says what to fix');
  assert.deepEqual(core.tableShapeWarnings({ headers: ['A'], rows: [['x']] }, 'ok'), [], 'well-formed → silent');
  assert.deepEqual(core.tableShapeWarnings(null, 'absent'), [], 'absent table → silent');
});

test('tcIdsForReq: explicit FR-ref column wins over fuzzy text', () => {
  const tc = {
    headers: ['TC ID', 'Flow', 'Test Case', 'Expected', 'FR'],
    rows: [
      ['TC-001', 'f', 'totally different text', 'ok', 'FR-001'],
      ['TC-002', 'f', 'unrelated', 'ok', 'FR-002'],
    ],
  };
  assert.deepEqual(core.tcIdsForReq(tc, 'the requirement prose', 'FR-001'), ['TC-001']);
});

test('tcIdsForReq: falls back to fuzzy text match when no FR column', () => {
  const tc = {
    headers: ['TC ID', 'Flow', 'Test Case', 'Expected'],
    rows: [['TC-001', 'f', 'login returns jwt', 'ok']],
  };
  assert.deepEqual(core.tcIdsForReq(tc, 'login returns jwt'), ['TC-001']);
});

// ---------------------------------------------------------------------------
// SRS parsing
// ---------------------------------------------------------------------------

test('parseSrs: featureName from "Feature:" line', () => {
  const srs = core.parseSrs('# Title\n\nFeature: My Cool Thing\n');
  assert.equal(srs.featureName, 'My Cool Thing');
});

test('parseSrs: strips a leading "SRS:" prefix from an H1-derived name (#5)', () => {
  const srs = core.parseSrs('# SRS: Outbox CDC Circuit Breaker\n\nbody\n');
  assert.equal(srs.featureName, 'Outbox CDC Circuit Breaker');
});

test('parseSrs: ID-prefix table detection is language-independent (#2)', () => {
  const md = [
    '# Feature: X',
    '',
    '## 5. Yeu cau chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | does X |',
    '| FR-2 | SHOULD | does Y |',
    '',
    '| Ma | Yeu cau |',
    '| --- | --- |',
    '| NFR-1 | fast |',
    '',
  ].join('\n');
  const srs = core.parseSrs(md);
  assert.ok(srs.frTable, 'frTable detected by FR- prefix');
  assert.equal(srs.frTable.rows.length, 2);
  assert.ok(srs.nfrTable, 'nfrTable detected by NFR- prefix');
});

// ---------------------------------------------------------------------------
// SD generation (genSd) — drives the Pass-1 skeleton + stats
// ---------------------------------------------------------------------------

test('genSd: harvests an ID-prefixed FR table into §5.1 (#2)', () => {
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | publish after commit |',
    '| FR-2 | SHOULD | retry with backoff |',
    '',
  ].join('\n'));
  const { sd, stats } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(stats.fr, 2, 'two FRs harvested by ID-prefix');
  assert.match(sd, /publish after commit/);
  assert.match(sd, /\| FR-001 \|/, 'renumbered to canonical FR-001');
});

test('genSd: a `|` harvested from the SRS is escaped, so the row keeps 4 columns', () => {
  // The SRS legitimately uses `|` as a delimiter. Interpolated raw it added a column:
  // §5.1 rendered shifted AND route/trace-build read the wrong cells.
  // The SRS is itself a well-formed markdown table: it escapes its own pipes. So the
  // value round-trips SRS → splitRow (unescape) → genSd (re-escape) with no loss and
  // no double-escaping.
  const srs = core.parseSrs([
    '# Feature: Signature',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | payload = merchantId\\|orderId\\|amount, then sha256 |',
    '',
  ].join('\n'));
  const { sd } = core.genSd(srs, { feature: 'signature' });
  const frRow = sd.split('\n').find((l) => l.startsWith('| FR-001 |'));
  assert.ok(frRow, '§5.1 has an FR-001 row');
  assert.match(frRow, /merchantId\\\|orderId\\\|amount/, 'pipes escaped in the cell');
  assert.equal(core.splitRow(frRow).length, 4, 'row still has exactly 4 cells');
  assert.match(core.splitRow(frRow)[1], /merchantId\|orderId\|amount/, 'parsed value is the plain `|`');
  assert.deepEqual(core.tableShapeWarnings(
    core.parseAllTables(sd.split('\n')).find((t) => /requirement/i.test(t.headers.join(' '))),
    '§5.1',
  ), [], 'the generated §5.1 is shape-clean');
  // And the SD tells the implementer not to copy the backslash into code.
  assert.match(sd, /U\+007C/, '§5.1 carries the escaping note');
});

test('genSd: free-form SRS with nothing parseable → TODO placeholders', () => {
  const srs = core.parseSrs('# Feature: Mystery\n\nJust prose, no tables, no user stories.\n');
  const { stats } = core.genSd(srs, { feature: 'mystery' });
  assert.equal(stats.fr, 0);
  assert.ok(stats.todoManualReview > 0, 'emits TODO markers when nothing harvested');
});

// ---------------------------------------------------------------------------
// genSd: silent-truncation regression. Measured on a real SRS, every FR/NFR
// harvested via the ID-prefix/business-logic fallback paths that ran past
// ~220 chars got cut mid-word at EXACTLY 220, several losing only the closing
// "." — an ordinary requirement sentence, not a pathological input. The cap
// is now a generous backstop (CELL_TEXT_CAP), not a routine limit: normal
// harvested text must survive whole, and only a truly pathological (2000+
// char) cell still gets cut — and even then must name the id in `warnings`.
// ---------------------------------------------------------------------------

test('REGRESSION genSd: a normal 357-char FR sentence (the exact shape that used to get cut at 220) survives whole, untruncated, no warning', () => {
  // Reproduces the reported shape: a single ordinary requirement sentence, well
  // past the old 220-char cap, ending in a period that used to be the first
  // thing lost.
  const longText = 'The system must validate the incoming payload against the registered schema, reject any field not declared in the contract, log a structured audit entry with correlation id and actor, and re-publish the normalized event to the downstream topic within the configured operational latency budget for this route.';
  assert.ok(longText.length > 220, 'sanity: the fixture is actually past the old cap');
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Mo ta |',
    '| --- | --- |',
    `| FR-1 | ${longText} |`,
    '',
  ].join('\n'));
  const { sd, warnings } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(warnings.filter((w) => w.startsWith('TRUNCATED')).length, 0, 'an ordinary long sentence must not be flagged as truncated');
  const frRow = sd.split('\n').find((l) => l.startsWith('| FR-001 |'));
  assert.ok(frRow && frRow.includes(longText), 'the full sentence, including its closing period, survives in the cell');
});

test('REGRESSION genSd: a business-logic rule past the pathological-length backstop is flagged as TRUNCATED', () => {
  const longRule = 'x'.repeat(2200);
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## Rules',
    '',
    '| Rule ID | Business Logic | Extra | Detail |',
    '| --- | --- | --- | --- |',
    `| BL-001 | short | n/a | ${longRule} |`,
    '',
  ].join('\n'));
  const { sd, warnings } = core.genSd(srs, { feature: 'outbox' });
  const w = warnings.join(' ');
  assert.match(w, /TRUNCATED/, 'a truncated BL-derived FR is flagged');
  assert.match(w, /FR-001/, 'names the truncated FR id');
  const frRow = sd.split('\n').find((l) => l.startsWith('| FR-001 |'));
  assert.ok(frRow && !frRow.includes(longRule), 'sanity: the row really was cut (not accidentally kept whole)');
});

test('REGRESSION genSd: an ID-prefix FR row past the pathological-length backstop is flagged as TRUNCATED', () => {
  const longText = 'y'.repeat(2200);
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Mo ta |',
    '| --- | --- |',
    `| FR-1 | ${longText} |`,
    '',
  ].join('\n'));
  const { warnings } = core.genSd(srs, { feature: 'outbox' });
  const w = warnings.join(' ');
  assert.match(w, /TRUNCATED/);
  assert.match(w, /FR-001/);
});

test('REGRESSION genSd: an ID-prefix TC row past the pathological-length backstop is flagged as TRUNCATED', () => {
  const longText = 'z'.repeat(2200);
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## Test Cases',
    '',
    '| Ma | Mo ta |',
    '| --- | --- |',
    `| TC-1 | ${longText} |`,
    '',
  ].join('\n'));
  const { warnings } = core.genSd(srs, { feature: 'outbox' });
  const w = warnings.join(' ');
  assert.match(w, /TRUNCATED/);
  assert.match(w, /TC-001/);
});

test('genSd: short FR/TC text under the cell cap produces no TRUNCATED warning', () => {
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Mo ta |',
    '| --- | --- |',
    '| FR-1 | publish after commit |',
    '',
  ].join('\n'));
  const { warnings } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(warnings.filter((w) => w.startsWith('TRUNCATED')).length, 0);
});

// ---------------------------------------------------------------------------
// genSd: §5.2 NFR column-resolution regression. The heading-harvested NFR
// table used to read columns POSITIONALLY (r[0]=requirement, r[1]=target),
// assuming the bare "Requirement | Target" shape. A richer SRS table —
// "ID | Category | Requirement | Target", the SD's OWN §5.2 convention — got
// its ID column read as the requirement TEXT, its real Category dumped into
// Target next to the actual target value, and every row force-labeled
// "Perf/Sec" regardless of its real category (Resilience, Regression, ...).
// ---------------------------------------------------------------------------

test('REGRESSION genSd: an "ID | Category | Requirement | Target" NFR table resolves columns by header, not by position', () => {
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 6. Non-Functional Requirements',
    '',
    '| ID | Category | Requirement | Target |',
    '| --- | --- | --- | --- |',
    '| NFR-01 | Performance | p95 latency stays under caller timeout | p95 < timeout caller |',
    '| NFR-02 | Resilience | retries survive a broker restart | 3 retries, exponential backoff |',
    '| NFR-03 | Regression | existing outbox consumers keep working | 0 breaking changes |',
    '',
  ].join('\n'));
  const { sd, stats } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(stats.nfr, 3);
  const rows = sd.split('\n').filter((l) => l.startsWith('| NFR-'));
  assert.equal(rows.length, 3);

  const cells = (row) => core.splitRow(row);
  const [r1, r2, r3] = rows;

  // Category column: each row's OWN category, never a hardcoded "Perf/Sec".
  assert.match(cells(r1)[1], /Performance/, 'row 1 keeps its real category');
  assert.match(cells(r2)[1], /Resilience/, 'row 2 is Resilience, not force-labeled Perf/Sec');
  assert.match(cells(r3)[1], /Regression/, 'row 3 is Regression, not force-labeled Perf/Sec');

  // Requirement column: the SRS's requirement TEXT, never the "NFR-01" id.
  assert.match(cells(r1)[2], /p95 latency stays under caller timeout/);
  assert.ok(!/^NFR-01$/.test(cells(r1)[2].trim()), 'the ID must not land in the Requirement column');

  // Target column: the SRS's real target value, not the category text stuffed alongside it.
  assert.match(cells(r1)[3], /p95 < timeout caller/);
  assert.ok(!/Performance/.test(cells(r1)[3]), 'the category must not be dumped into Target');
});

test('genSd: a bare "Requirement | Target" NFR table (no ID/Category columns) still falls back to the positional heuristic', () => {
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 6. Non-Functional Requirements',
    '',
    '| Requirement | Target |',
    '| --- | --- |',
    '| Response time (p99) | 200ms |',
    '',
  ].join('\n'));
  const { sd, stats } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(stats.nfr, 1);
  const row = sd.split('\n').find((l) => l.startsWith('| NFR-001 |'));
  const cells = core.splitRow(row);
  assert.match(cells[1], /Perf\/Sec/, 'legacy 2-col shape keeps the old presence-of-target heuristic');
  assert.match(cells[2], /Response time/);
  assert.match(cells[3], /200ms/);
});

test('countSdTodos: only the marker blockquote counts, not the prose that mentions it', () => {
  // Every line below legitimately contains the string in a CLEARED, approved SD.
  // A bare /TODO:MANUAL-REVIEW/ counted all of them and gated work that was ready.
  const sd = [
    '> Generated by spec-flow Pass-1 from SRS. Sections marked TODO:MANUAL-REVIEW need Pass-2.',
    '',
    '## Revision History',
    '| v0.2 | Cleared the last TODO:MANUAL-REVIEW in §7.2 | sd-author |',
    '',
    '<!-- Pass-2 summary: TODO:MANUAL-REVIEW remaining: 0 -->',
    'Prose that says a reviewer should resolve any TODO:MANUAL-REVIEW before approval.',
  ].join('\n');
  assert.equal(core.countSdTodos(sd), 0, 'prose mentions are not unresolved markers');

  const withMarkers = [sd, '', core.TODO('§7.2 column types'), core.TODO('§9.3 error mapping')].join('\n');
  assert.equal(core.countSdTodos(withMarkers), 2, 'counts exactly the TODO() blockquotes');
  assert.equal(core.countSdTodos(''), 0);
  assert.equal(core.countSdTodos(null), 0);
});

test('genSd: §12.2 placeholder row (FR/TC table SRS, no user stories) is still gated', () => {
  // Regression: an SRS shaped as FR/TC/NFR tables (no user-story edges) leaves
  // §12.2 error codes with nothing to harvest (ecN stays 0 regardless of the FR/NFR/TC
  // tables being present — there is no error-code table fallback). The old code embedded
  // the placeholder's TODO marker in the table row via `.replace(/^> /, '')`, which only
  // strips the leading `> ` — but the *line* itself starts with `|`, so the old
  // line-anchored SD_TODO_RE never matched it either way, silently ungating the row.
  const srs = core.parseSrs([
    '# Feature: Outbox',
    '',
    '## 5. Chuc nang',
    '',
    '| Ma | Muc do | Mo ta |',
    '| --- | --- | --- |',
    '| FR-1 | MUST | publish after commit |',
    '',
  ].join('\n'));
  const { sd, stats } = core.genSd(srs, { feature: 'outbox' });
  assert.equal(stats.fr, 1, 'FR table harvested normally');
  assert.equal(stats.errorCodes, 0, 'no user-story edges to derive error codes from');

  const ecRow = sd.split('\n').find((l) => l.startsWith('| ERR_GENERIC_001 |'));
  assert.ok(ecRow, '§12.2 emits the generic-error placeholder row');
  assert.ok(!ecRow.startsWith('>'), 'the row is a table line, not a blockquote');
  assert.match(ecRow, /\*\*TODO:MANUAL-REVIEW\*\*/, 'the row still carries the bold marker');
  assert.ok(stats.todoManualReview > 0 && core.countSdTodos(sd) === stats.todoManualReview);
  assert.ok(core.countSdTodos(ecRow) > 0, '§12.2 placeholder row alone is counted as an unresolved marker');
});

test('genSd: epic-scale flag trips past the FR threshold', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| FR-${i + 1} | MUST | requirement ${i} |`);
  const srs = core.parseSrs(['# Feature: Big', '', '## Reqs', '', '| Ma | P | D |', '| --- | --- | --- |', ...rows, ''].join('\n'));
  const { stats, warnings } = core.genSd(srs, { feature: 'big' });
  assert.ok(stats.fr >= 25);
  assert.ok(stats.epicScale, 'epicScale set');
  assert.ok(warnings.some((w) => /EPIC-SCALE/.test(w)));
});

test('parseProseBullets: groups bullets by nearest heading, skips tables and noise', () => {
  const md = [
    '# SRS — X', '',
    'intro prose no bullet', '',
    '## 5. Functional Requirements',
    '- The system MUST do A.',
    '1. The system MUST do B.',
    '| col | col2 |', '| --- | --- |', '| - not a bullet | x |',
    '- ok', // <4 chars after normalize? "ok" length 2 → skipped
    '## 6. Business Rules',
    '* BR: never do C.',
  ].join('\n');
  const m = core.parseProseBullets(md);
  const fr = m.get('5. Functional Requirements');
  assert.deepEqual(fr, ['The system MUST do A.', 'The system MUST do B.']);
  const br = m.get('6. Business Rules');
  assert.deepEqual(br, ['BR: never do C.']);
});

// ---------------------------------------------------------------------------
// versionSyncStatus — .claude-plugin/plugin.json vs marketplace.json.
//
// Regression guard for a drift nothing was checking: this repo shipped 18
// consecutive tags (v0.5.8 through v0.8.1) whose marketplace metadata still read
// 0.5.5 while plugin.json had reached 0.8.1, so the marketplace advertised a
// version nobody was running. Two hand-edited files that must move together on
// every release is exactly the shape a check has to cover.
// ---------------------------------------------------------------------------

const mkPlugin = (v) => (v === undefined ? {} : { version: v });
const mkMarket = (v) => (v === undefined ? { metadata: {} } : { metadata: { version: v } });

test('versionSyncStatus: matching versions are ok', () => {
  const r = core.versionSyncStatus(mkPlugin('0.8.7'), mkMarket('0.8.7'));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /both at 0\.8\.7/);
  assert.equal(r.fix, null);
});

test('versionSyncStatus: the historical 0.8.1-vs-0.5.5 drift is caught', () => {
  const r = core.versionSyncStatus(mkPlugin('0.8.1'), mkMarket('0.5.5'));
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /plugin\.json is 0\.8\.1/);
  assert.match(r.detail, /marketplace.*0\.5\.5/);
  assert.match(r.detail, /advertises 0\.5\.5/, 'the detail says what users actually see');
  assert.match(r.fix, /set marketplace\.json metadata\.version to 0\.8\.1/);
});

test('versionSyncStatus: a one-release lag is caught too (the v0.8.2 / v0.8.3 case)', () => {
  const r = core.versionSyncStatus(mkPlugin('0.8.3'), mkMarket('0.8.2'));
  assert.equal(r.status, 'warn');
  assert.equal(r.pluginVersion, '0.8.3');
  assert.equal(r.marketplaceVersion, '0.8.2');
});

test('versionSyncStatus: an unreadable file reports as unreadable, not as drift', () => {
  // A partial install is not a release defect — saying "drift" there would send
  // the reader to edit a version field when the fix is to reinstall.
  const r = core.versionSyncStatus(null, mkMarket('0.8.7'));
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /unreadable or missing: plugin\.json/);
  assert.match(r.fix, /reinstall/);
  assert.doesNotMatch(r.detail, /drift/);
});

test('versionSyncStatus: a missing version field names which one', () => {
  const r = core.versionSyncStatus(mkPlugin(undefined), mkMarket('0.8.7'));
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /plugin\.json\.version/);
  assert.doesNotMatch(r.detail, /marketplace\.json\.metadata\.version/);

  const r2 = core.versionSyncStatus(mkPlugin('0.8.7'), mkMarket(undefined));
  assert.match(r2.detail, /marketplace\.json\.metadata\.version/);
});

test('versionSyncStatus: a non-string version is treated as absent, not compared', () => {
  const r = core.versionSyncStatus({ version: 87 }, mkMarket('0.8.7'));
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /version field absent/);
});

// ---------------------------------------------------------------------------
// pluginSourceDrift — a directory-sourced plugin runs from a version-keyed CACHE
// copy, not from the source repo. Between releases the version does not move, so
// the cache never refreshes and every edit to the source is silently inert: a new
// engine command answers UNKNOWN_COMMAND and an edited command doc is just the old
// one. Verified by hand on this machine: the cache sat at commit 613b14b with no
// lib/review.cjs while the repo had it, and nothing in doctor said so.
// ---------------------------------------------------------------------------

const CACHE = '/home/u/.claude/plugins/cache/mp/sf/0.11.1';
const SRC = '/home/u/git/spec-flow';
const installedAt = (installPath) => ({ plugins: { 'sf@mp': [{ installPath }] } });
const dirMarket = (p) => ({ mp: { source: { source: 'directory', path: p } } });
/** compare() stub — the I/O half is injected, so these tests touch no disk. */
const cmp = (differing, compared = 100) => () => ({ differing, compared });
/** compare() stub for a source directory that has been moved or deleted. */
const cmpMissing = () => () => ({ differing: [], compared: 0, missingSource: true });

test('pluginSourceDrift: a clean cache copy is ok', () => {
  const r = core.pluginSourceDrift(CACHE, installedAt(CACHE), dirMarket(SRC), cmp([]));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /matches its source directory/);
  assert.equal(r.fix, null);
});

test('pluginSourceDrift: a stale cache warns, names the files, and hands over the sync command', () => {
  const r = core.pluginSourceDrift(CACHE, installedAt(CACHE), dirMarket(SRC), cmp(['lib/review.cjs', 'commands/phase.md'], 105));
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /2\/105 file\(s\) differ/);
  assert.match(r.detail, /lib\/review\.cjs/);
  // The detail must explain WHY, or the reader re-runs /plugin update and it does nothing.
  assert.match(r.detail, /keyed by version/);
  assert.match(r.fix, /^rsync -a --delete/);
  assert.ok(r.fix.includes(SRC) && r.fix.includes(CACHE), 'the fix is copy-pasteable, not a template');
});

test('pluginSourceDrift: more than five differing files are summarised, not dumped', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `lib/${x}.cjs`);
  const r = core.pluginSourceDrift(CACHE, installedAt(CACHE), dirMarket(SRC), cmp(many));
  assert.match(r.detail, /\+2 more/);
});

test('pluginSourceDrift: running from the source checkout is not drift', () => {
  // PLUGIN_ROOT is the repo itself (a contributor running the engine directly).
  // No installPath matches, so there is no cache to be stale.
  const r = core.pluginSourceDrift(SRC, installedAt(CACHE), dirMarket(SRC), cmp(['x']));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /source checkout/);
});

test('pluginSourceDrift: a github-sourced install is not applicable', () => {
  // The overwhelming majority of users. The check must stay silent for them.
  const github = { mp: { source: { source: 'github', repo: 'o/r' } } };
  const r = core.pluginSourceDrift(CACHE, installedAt(CACHE), github, cmp(['x']));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /not a local directory source/);
});

test('pluginSourceDrift: a directory source that IS the running root is not drift', () => {
  const r = core.pluginSourceDrift(SRC, installedAt(SRC), dirMarket(SRC), cmp(['x']));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /runs directly from its source directory/);
});

test('pluginSourceDrift: a vanished source directory warns without claiming drift', () => {
  const gone = '/nope/does/not/exist';
  const r = core.pluginSourceDrift(CACHE, installedAt(CACHE), dirMarket(gone), cmpMissing());
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /no longer exists/);
  assert.doesNotMatch(r.detail, /stale/);
});

test('pluginSourceDrift: missing install metadata is ok, not a false alarm', () => {
  assert.equal(core.pluginSourceDrift(CACHE, null, dirMarket(SRC), cmp(['x'])).status, 'ok');
  assert.equal(core.pluginSourceDrift(CACHE, installedAt(CACHE), null, cmp(['x'])).status, 'ok');
});

test('pluginSourceDrift: the installPath match is exact, not a substring', () => {
  // ".../sf/0.11.1" must not match ".../sf/0.11.10" — a real risk once a plugin
  // reaches a two-digit patch, and it would compare the wrong tree.
  const r = core.pluginSourceDrift(CACHE + '0', installedAt(CACHE), dirMarket(SRC), cmp(['x']));
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /source checkout/);
});

// ---------------------------------------------------------------------------
// Per-repo build tool (mixed-toolchain hubs)
// ---------------------------------------------------------------------------

const fsx = require('node:fs');
const osx = require('node:os');
const pathx = require('node:path');

/** Temp dir seeded with the given marker files (name → contents). */
function mkRepo(markers) {
  const d = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'sf-repo-'));
  for (const [name, body] of Object.entries(markers || {})) {
    fsx.writeFileSync(pathx.join(d, name), body == null ? '' : String(body));
  }
  return d;
}

test('resolveRepos: string entry keeps the old shape and adds null overrides', () => {
  const cwd = process.cwd();
  const roots = core.resolveRepos({ repos: { 'svc-a': '../svc-a' } });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, 'svc-a');
  assert.equal(roots[0].root, pathx.resolve(cwd, '../svc-a'));
  assert.equal(roots[0].stack, null);
  assert.equal(roots[0].verify, null);
});

test('resolveRepos: object entry carries path + per-repo stack/verify overrides', () => {
  const roots = core.resolveRepos({
    repos: {
      'svc-a': '../svc-a',
      'gw': { path: '../gw', stack: 'java-maven', verify: { testCommand: 'mvn -q test' } },
    },
  });
  const gw = roots.find((r) => r.name === 'gw');
  assert.equal(gw.root, pathx.resolve(process.cwd(), '../gw'));
  assert.equal(gw.stack, 'java-maven');
  assert.deepEqual(gw.verify, { testCommand: 'mvn -q test' });
  assert.equal(roots.find((r) => r.name === 'svc-a').stack, null, 'string entries unaffected');
});

test('resolveRepos: no repos → single cwd root (backward compat)', () => {
  const roots = core.resolveRepos({ stack: 'node' });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].name, null);
  assert.equal(roots[0].root, process.cwd());
});

test('detectRepoStack: recognizes gradle / maven / node / python / go by marker', () => {
  assert.deepEqual(core.detectRepoStack(mkRepo({ 'build.gradle': '', gradlew: '' })),
    { stack: 'java-spring', testCommand: './gradlew test' });
  assert.deepEqual(core.detectRepoStack(mkRepo({ 'build.gradle.kts': '' })),
    { stack: 'java-spring', testCommand: 'gradle test' });
  assert.deepEqual(core.detectRepoStack(mkRepo({ 'pom.xml': '', mvnw: '' })),
    { stack: 'java-maven', testCommand: './mvnw -q test' });
  assert.deepEqual(core.detectRepoStack(mkRepo({ 'pom.xml': '' })),
    { stack: 'java-maven', testCommand: 'mvn -q test' });
  assert.equal(core.detectRepoStack(mkRepo({ 'package.json': '{}' })).stack, 'node');
  assert.equal(core.detectRepoStack(mkRepo({ 'go.mod': '' })).stack, 'go');
  assert.equal(core.detectRepoStack(mkRepo({ 'README.md': '' })), null, 'unknown root → null');
});

test('detectRepoStack: gradle wins over maven when a repo carries both', () => {
  const d = mkRepo({ 'build.gradle': '', gradlew: '', 'pom.xml': '' });
  assert.equal(core.detectRepoStack(d).stack, 'java-spring');
});

test('commandRunsIn: false only when the answer is certain', () => {
  const maven = mkRepo({ 'pom.xml': '', mvnw: '' });
  const gradle = mkRepo({ 'build.gradle': '', gradlew: '' });
  assert.equal(core.commandRunsIn('./gradlew test', maven), false, 'no gradlew on disk');
  assert.equal(core.commandRunsIn('./gradlew test', gradle), true);
  assert.equal(core.commandRunsIn('mvn -q test', gradle), false, 'no pom.xml');
  assert.equal(core.commandRunsIn('mvn -q test', maven), true);
  assert.equal(core.commandRunsIn('npm test', maven), false, 'no package.json');
  // Unrecognized / absolute / empty → never second-guessed.
  assert.equal(core.commandRunsIn('for f in test/*.cjs; do node "$f"; done', maven), true);
  assert.equal(core.commandRunsIn('/usr/local/bin/ci-test', maven), true);
  assert.equal(core.commandRunsIn(null, maven), true);
});

test('resolveRepoVerify: explicit per-repo override wins, no auto-detection note', () => {
  const gw = mkRepo({ 'pom.xml': '', mvnw: '' });
  const eff = core.resolveRepoVerify(
    { stack: 'java-spring', verify: { testCommand: './gradlew test', coverageThreshold: 80 } },
    { name: 'gw', root: gw, stack: 'java-maven', verify: { testCommand: 'mvn -q test' } },
  );
  assert.equal(eff.stack, 'java-maven');
  assert.equal(eff.verify.testCommand, 'mvn -q test');
  assert.equal(eff.verify.coverageThreshold, 80, 'unlisted keys inherit from the project verify block');
  assert.equal(eff.note, null, 'explicit config is never overridden by detection');
});

test('resolveRepoVerify: auto-detects when the inherited command cannot run there', () => {
  const gw = mkRepo({ 'pom.xml': '', mvnw: '' });
  const eff = core.resolveRepoVerify(
    { stack: 'java-spring', verify: { testCommand: './gradlew test' } },
    { name: 'eid-gateway', root: gw, stack: null, verify: null },
  );
  assert.equal(eff.stack, 'java-maven');
  assert.equal(eff.verify.testCommand, './mvnw -q test');
  assert.match(eff.note, /auto-detected java-maven in eid-gateway/);
  assert.equal(eff.detected, true);
});

test('resolveRepoVerify: a runnable inherited command is left alone', () => {
  const svc = mkRepo({ 'build.gradle': '', gradlew: '' });
  const eff = core.resolveRepoVerify(
    { stack: 'java-spring', verify: { testCommand: './gradlew test' } },
    { name: 'wallet-ms', root: svc, stack: null, verify: null },
  );
  assert.equal(eff.stack, 'java-spring');
  assert.equal(eff.verify.testCommand, './gradlew test');
  assert.equal(eff.note, null);
});

test('resolveRepoVerify: unrunnable command + unknown build tool → note, command untouched', () => {
  const bare = mkRepo({ 'README.md': '' });
  const eff = core.resolveRepoVerify(
    { stack: 'java-spring', verify: { testCommand: './gradlew test' } },
    { name: 'docs-repo', root: bare, stack: null, verify: null },
  );
  assert.equal(eff.verify.testCommand, './gradlew test', 'nothing to swap in — leave it');
  assert.match(eff.note, /no known build tool was detected/);
});

// --- US-5: parseUserStories must accept the SHIPPED template's US form -----
// FR-027/FR-030, BL-11. parseHeadings only matches ATX headings (^#{1,6}\s+),
// and parseUserStories iterates only those — but templates/srs-template.md
// writes user stories as a BOLD PARAGRAPH (**US-1: <name>**). Anyone following
// the shipped template harvested 0 stories -> 0 FR -> 0 TC, with no warning.

test('parseUserStories: bold-paragraph form (**US-1: ...**) is parsed', () => {
  const md = [
    '# Feature: x',
    '## 4. User Stories',
    '',
    '**US-1: bold form story**',
    '',
    '- As a developer,',
    '- I want to X,',
    '- So that Y.',
    '',
    '#### Acceptance Criteria',
    '',
    '- first criterion',
    '- second criterion',
    '',
    '#### Edge Cases',
    '',
    '- an edge',
    '',
  ].join('\n');
  const st = core.parseUserStories(md);
  assert.equal(st.length, 1, 'bold-paragraph US must be found');
  assert.equal(st[0].id, 'US-1');
  assert.equal(st[0].name, 'bold form story');
  assert.equal(st[0].role, 'developer');
  assert.deepEqual(st[0].acceptance, ['first criterion', 'second criterion']);
  assert.deepEqual(st[0].edges, ['an edge']);
});

test('parseUserStories: ATX heading form still works, two-digit ids included', () => {
  const md = [
    '## 4. User Stories',
    '### US-01: heading form',
    '- As an operator,',
    '#### Acceptance Criteria',
    '- crit a',
    '### US-02: second',
    '- As an admin,',
    '#### Acceptance Criteria',
    '- crit b',
  ].join('\n');
  const st = core.parseUserStories(md);
  assert.equal(st.length, 2);
  assert.equal(st[0].id, 'US-01');
  assert.equal(st[1].id, 'US-02');
  assert.equal(st[0].role, 'operator');
  assert.deepEqual(st[1].acceptance, ['crit b']);
});

test('parseUserStories: mixed forms do not produce a duplicate story', () => {
  const md = [
    '## 4. User Stories',
    '### US-1: heading wins',
    '- As a developer,',
    '#### Acceptance Criteria',
    '- from heading',
    '',
    '**US-1: bold duplicate**',
    '',
    '- As an intruder,',
    '',
  ].join('\n');
  const st = core.parseUserStories(md);
  assert.equal(st.length, 1, 'same id must not be emitted twice');
  assert.equal(st[0].name, 'heading wins', 'first occurrence wins');
});

test('parseUserStories: a bold line that merely mentions US-N is not a story', () => {
  const md = [
    '## 4. User Stories',
    '**US-1: real story**',
    '- As a developer,',
    '',
    'Some prose that references **US-1** inline and must not create a story.',
    '',
  ].join('\n');
  const st = core.parseUserStories(md);
  assert.equal(st.length, 1);
});

// --- US-5: the shipped SRS template must parse with the shipped parser ----
// FR-025/FR-026 + TC-035/TC-037. A template that cannot parse itself is the
// fail condition (BL-13): Pass-1 harvest exists to save sd-author tokens, and
// it silently produced 0 FR / 0 TC / 0 NFR for anyone following the template.

test('parseSrs: the shipped srs-template.md harvests stories and an NFR table', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const md = fs2.readFileSync(path2.join(__dirname, '..', 'templates', 'srs-template.md'), 'utf8');
  const s = core.parseSrs(md);
  assert.ok(s.stories.length > 0, 'template must yield at least one user story');
  assert.ok(s.nfrTable && s.nfrTable.rows.length > 0,
    'template §6.1 NFR table must be found by the NFR- id prefix');
  // The acceptance-criteria bullets are what Pass-1 turns into FR + TC rows, so
  // the template must SHOW parseable bullets, not describe them in prose.
  assert.ok(s.stories[0].acceptance.length > 0,
    'template US-1 must carry example acceptance bullets (they become FR/TC rows)');
  assert.ok(s.stories[0].edges.length > 0,
    'template US-1 must carry example edge-case bullets');
});

test('parseSrs: NFR ids are found even when they are not in column 0', () => {
  const md = [
    '# Feature: x',
    '## 6. Non-Functional Requirements',
    '',
    '| STT | ID | Requirement | Target |',
    '| --- | --- | --- | --- |',
    '| 1 | NFR-1 | Response time | p99 < 200ms |',
    '| 2 | NFR-2 | Throughput | 1000 rps |',
    '',
  ].join('\n');
  const s = core.parseSrs(md);
  assert.ok(s.nfrTable, 'NFR table must be found when ids sit in column 1');
  assert.equal(s.nfrTable.rows.length, 2);
  assert.equal(s.nfrTable.idCol, 1, 'the matched id column index must be reported');
});

test('parseSrs: FR/TC id tables still resolve from column 0', () => {
  const md = [
    '# Feature: x',
    '## 5. Functional Requirements',
    '',
    '| ID | Requirement | Priority |',
    '| --- | --- | --- |',
    '| FR-1 | do a thing | Must Have |',
    '',
    '| TC ID | Test Case | Flow |',
    '| --- | --- | --- |',
    '| TC-1 | verify the thing | happy |',
    '',
  ].join('\n');
  const s = core.parseSrs(md);
  assert.equal(s.frTable.rows.length, 1);
  assert.equal(s.frTable.idCol, 0);
  assert.equal(s.tcTable.rows.length, 1);
});

// --- US-5: EMPTY_HARVEST — a silent zero harvest is not acceptable --------
// FR-028/FR-029, BL-12, D7. sd-skeleton used to report userStories:0, fr:0,
// testCases:0 with an EMPTY warnings array: the failure was invisible and the
// whole cost silently moved to sd-author, the most expensive pass. Warning
// only — never blocks, since an SRS may legitimately be mid-draft.

test('genSd: EMPTY_HARVEST names every bucket that came back zero', () => {
  const srs = core.parseSrs('# Feature: nothing\n\nJust prose, no tables, no stories.\n');
  const r = core.genSd(srs, { type: 'api', feature: 'nothing' });
  const w = r.warnings.find(x => x.startsWith('EMPTY_HARVEST'));
  assert.ok(w, 'an all-zero harvest must produce an EMPTY_HARVEST warning');
  for (const bucket of ['userStories', 'fr', 'tc']) {
    assert.ok(w.includes(bucket), `warning must name the empty bucket "${bucket}"`);
  }
  assert.ok(/###\s*US-|Acceptance/i.test(w), 'warning must hint at the expected format');
  assert.equal(r.stats.userStories, 0);
  assert.ok(typeof r.sd === 'string' && r.sd.length > 0, 'D7: still returns an SD, never blocks');
});

test('genSd: a healthy harvest produces no EMPTY_HARVEST warning', () => {
  const md = [
    '# Feature: healthy',
    '## 4. User Stories',
    '### US-1: a story',
    '- As a developer,',
    '#### Acceptance Criteria',
    '- the thing works',
    '- the other thing works',
  ].join('\n');
  const r = core.genSd(core.parseSrs(md), { type: 'api', feature: 'healthy' });
  assert.equal(r.warnings.filter(x => x.startsWith('EMPTY_HARVEST')).length, 0);
  assert.ok(r.stats.fr > 0);
});

test('genSd: a partial harvest flags only the buckets that are empty', () => {
  const md = [
    '# Feature: partial',
    '## 4. User Stories',
    '### US-1: a story',
    '- As a developer,',
    '#### Acceptance Criteria',
    '- the thing works',
  ].join('\n');
  const r = core.genSd(core.parseSrs(md), { type: 'api', feature: 'partial' });
  const w = r.warnings.find(x => x.startsWith('EMPTY_HARVEST'));
  if (w) {
    assert.ok(!w.includes('userStories'), 'a bucket that harvested rows must not be listed');
    assert.ok(!w.includes(' fr'), 'fr harvested rows, so it must not be listed');
  }
});

test('genSd: no EMPTY_HARVEST when FR+TC are healthy but the SRS uses no user stories', () => {
  // 30/33 real SRSs write FR tables directly and never use a user-story section.
  // That is a legitimate authoring style, not a harvest failure — warning on it
  // would make EMPTY_HARVEST fire on almost every real document and mean nothing.
  const md = [
    '# Feature: table-style',
    '## 5. Functional Requirements',
    '',
    '| ID | Requirement | Priority |',
    '| --- | --- | --- |',
    '| FR-1 | do a thing | Must Have |',
    '| FR-2 | do another | Must Have |',
    '',
    '| TC ID | Test Case | Flow |',
    '| --- | --- | --- |',
    '| TC-1 | verify thing | happy |',
    '',
  ].join('\n');
  const r = core.genSd(core.parseSrs(md), { type: 'api', feature: 'table-style' });
  assert.equal(r.stats.userStories, 0);
  assert.ok(r.stats.fr > 0 && r.stats.testCases > 0);
  assert.equal(r.warnings.filter(x => x.startsWith('EMPTY_HARVEST')).length, 0,
    'a healthy FR+TC harvest must not warn merely because user stories are absent');
});

test('genSd: FRs with zero test cases is flagged as a coverage gap', () => {
  const md = [
    '# Feature: no-tests',
    '## 5. Functional Requirements',
    '',
    '| ID | Requirement | Priority |',
    '| --- | --- | --- |',
    '| FR-1 | do a thing | Must Have |',
    '',
  ].join('\n');
  const r = core.genSd(core.parseSrs(md), { type: 'api', feature: 'no-tests' });
  const w = r.warnings.find(x => x.startsWith('EMPTY_HARVEST'));
  assert.ok(w, 'FR present but TC empty is a real gap and must warn');
  assert.ok(w.includes('tc'), 'the warning must name tc');
});
