'use strict';
// hybrid-executor / phase prompt contract: tests are written at each TC's declared
// Level (FR-012), no silent self-upgrade to an integration test (FR-013), and the
// orchestrator accepts live-only evidence (FR-014). The policy text stays
// stack-agnostic (D6 / TC-020).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXECUTOR = fs.readFileSync(path.join(__dirname, '..', 'agents', 'hybrid-executor.md'), 'utf8');
const PHASE = fs.readFileSync(path.join(__dirname, '..', 'commands', 'phase.md'), 'utf8');

const FRAMEWORKS = /spring|junit|jest|pytest|mockito|webflux|flyway|testcontainers/i;
const LIVE_ONLY = 'live-only TCs — proven by CHECKLIST';

// Procedure step 3 body: from "3. **TDD" up to "4. **TDD".
function step3() {
  const start = EXECUTOR.search(/^3\. \*\*TDD/m);
  assert.ok(start >= 0, 'step 3 not found');
  const rest = EXECUTOR.slice(start);
  const end = rest.search(/^4\. \*\*TDD/m);
  assert.ok(end > 0, 'step 4 not found');
  return rest.slice(0, end);
}

// Paragraphs of step 3 that carry the Level policy (mention Level, live or self-upgrade).
function levelParagraphs() {
  return step3()
    .split(/\n\s*\n/)
    .filter((p) => /\bLevel\b|\blive\b|upgrade/.test(p));
}

test('hybrid-executor: contains the live-only phrase verbatim (em dash)', () => {
  assert.ok(EXECUTOR.includes(LIVE_ONLY), 'live-only phrase missing');
});

test('hybrid-executor: live TC means no test code, all-live task skips RED', () => {
  const s = step3();
  assert.match(s, /`live`[^\n]*(NO|no|not|never)[^\n]*test code/);
  assert.match(s, /every TC[^\n]*`live`|all[^\n]*TCs?[^\n]*`live`/i);
  assert.match(s, /RED phase/);
  const idx = s.indexOf(LIVE_ONLY);
  assert.ok(idx >= 0);
});

test('hybrid-executor: tests are written at each TC Level, mixed tasks covered', () => {
  const s = step3();
  assert.match(s, /§13\.2/);
  assert.match(s, /Level/);
  assert.match(s, /`unit`[^\n]*`slice`[^\n]*`it`/);
  assert.match(s, /[Mm]ixed/);
  assert.match(s, /## Code Rules/);
});

test('hybrid-executor: no self-upgrade, report drift, point to /sf:change', () => {
  const s = step3();
  assert.match(s, /self-upgrade|silently raise/i);
  assert.match(s, /STOP/);
  assert.match(s, /drift/i);
  assert.match(s, /\/sf:change/);
  assert.match(s, /never[^\n]*integration[^\n]*`unit`[^\n]*`slice`[^\n]*`live`|never[^\n]*`it`[^\n]*`unit`/i);
});

test('hybrid-executor: no-Level-column fallback behaves exactly as today', () => {
  const s = step3();
  assert.match(s, /no `?Level`? column/i);
  assert.match(s, /exactly as (today|before)/i);
});

test('hybrid-executor: Level policy paragraphs name no framework or tool (D6)', () => {
  const paras = levelParagraphs();
  assert.ok(paras.length >= 2, 'expected the Level policy paragraphs in step 3');
  for (const p of paras) assert.doesNotMatch(p, FRAMEWORKS);
  assert.doesNotMatch(LIVE_ONLY, FRAMEWORKS);
});

test('phase: step 2 accepts the live-only phrase as TDD evidence next to the chore wording', () => {
  assert.ok(PHASE.includes(LIVE_ONLY), 'live-only phrase missing in phase.md');
  const para = PHASE.split(/\n\s*\n/).find((p) => p.includes('Check TDD evidence'));
  assert.ok(para, 'TDD evidence paragraph not found');
  assert.ok(para.includes(LIVE_ONLY), 'live-only phrase must sit in the TDD evidence paragraph');
  assert.ok(para.includes('chore — RED phase skipped'), 'chore wording must stay in the same paragraph');
  assert.match(para, /no (extra|further|additional)[^.]*RED/i);
  assert.doesNotMatch(para, FRAMEWORKS);
});
