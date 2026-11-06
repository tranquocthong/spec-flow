/**
 * Project judgment rules (project-author.md) — extraction + the engine surface the
 * orchestrator pastes from. Regression for the plat-int-test p7 miss: the team's
 * rules lived under `## Code review checklist (project-owned)` (pre-v0.13 template),
 * the gate only looked for `## Code Rules`, so executors got zero rules, no
 * compliance table was expected, and a ResponseEntity endpoint shipped.
 *
 * Run:  node --test test/project-rules.test.cjs   (or: node --test test/*.test.cjs)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractProjectRules } = require('../lib/code-rules.cjs');
const review = require('../lib/review.cjs');
const maintenance = require('../lib/maintenance.cjs');

const root = path.resolve(__dirname, '..');

function inTmp(fn) {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-project-rules-'));
  try { process.chdir(dir); return fn(dir); } finally { process.chdir(prev); }
}
function writeSpecFlow({ author, config }) {
  fs.mkdirSync('.spec-flow', { recursive: true });
  if (author !== undefined) fs.writeFileSync('.spec-flow/project-author.md', author);
  fs.writeFileSync('.spec-flow/config.json', JSON.stringify(config || {}, null, 2));
}

const LEGACY = [
  '# Project SD-authoring overrides',
  '',
  '## Known pitfalls',
  '',
  '- not a rule: pitfalls are SD guidance',
  '',
  '## Code review checklist (project-owned)',
  '',
  '> Generic checklist — add or remove items.',
  '',
  '- [ ] No secrets committed',
  '- [x] Java: controller responses use `@ResponseStatus`, not `ResponseEntity<T>` wrapping',
  '',
  '> Add YOUR stack\'s anti-patterns here',
  '',
  '- [ ] Java: every outbound `WebClient` is built from the factory',
  '  with a `clientName` (continuation line)',
  '',
  '## Learned rules (appended by spec-flow learn)',
  '',
  '- not a rule either',
].join('\n');

test('extractProjectRules: legacy "Code review checklist" heading is a rule source (p7 regression)', () => {
  const { rules, sections } = extractProjectRules(LEGACY);
  assert.deepEqual(sections, ['Code review checklist (project-owned)']);
  assert.deepEqual(rules.map((r) => r.id), ['R1', 'R2', 'R3']);
  assert.equal(rules[0].text, 'No secrets committed');
  assert.match(rules[1].text, /^Java: controller responses use `@ResponseStatus`/);
  assert.equal(rules[2].text, 'Java: every outbound `WebClient` is built from the factory with a `clientName` (continuation line)');
});

test('extractProjectRules: ## Code Rules + checklist both count; comments and blockquotes never do', () => {
  const md = [
    '## Code Rules',
    '',
    '> Judgment rules go here, one bullet each.',
    '> - a quoted bullet is template guidance',
    '',
    '<!-- One bullet per judgment rule, e.g.:',
    '- Controllers return @ResponseStatus, never wrap the body in ResponseEntity',
    '-->',
    '',
    '- Use Instant for timestamps',
    '',
    '### Sub-heading stays inside the section',
    '* Scheduled jobs take a ShedLock',
    '',
    '## Code review checklist',
    '- [ ] Errors handled, not swallowed',
  ].join('\n');
  const { rules, sections } = extractProjectRules(md);
  assert.deepEqual(sections, ['Code Rules', 'Code review checklist']);
  assert.deepEqual(rules.map((r) => [r.id, r.text, r.section]), [
    ['R1', 'Use Instant for timestamps', 'Code Rules'],
    ['R2', 'Scheduled jobs take a ShedLock', 'Code Rules'],
    ['R3', 'Errors handled, not swallowed', 'Code review checklist'],
  ]);
});

test('extractProjectRules: empty / missing input never throws', () => {
  assert.deepEqual(extractProjectRules(''), { rules: [], sections: [] });
  assert.deepEqual(extractProjectRules(undefined), { rules: [], sections: [] });
  assert.deepEqual(extractProjectRules('# Title\n\n## Stack\n- Stack: java\n').rules, []);
});

test('extractProjectRules: the sf:init template ships zero live rules under ## Code Rules', () => {
  inTmp(() => {
    maintenance['init-project']({ stack: 'node' });
    const md = fs.readFileSync('.spec-flow/project-author.md', 'utf8');
    const { rules } = extractProjectRules(md);
    assert.ok(rules.length > 0, 'template checklist bullets are binding');
    assert.ok(rules.every((r) => r.section.startsWith('Code review checklist')),
      'the commented-out ## Code Rules example must not become a rule');
  });
});

test('code-rules-list: returns ids + RULES_REVIEWER_OFF when phase.codeReview is off', () => {
  inTmp(() => {
    writeSpecFlow({ author: LEGACY, config: {} });
    const r = review['code-rules-list']({});
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 3);
    assert.equal(r.data.codeReviewGate, 'off');
    assert.equal(r.data.warnings.length, 1);
    assert.match(r.data.warnings[0], /^RULES_REVIEWER_OFF: 3 project rule/);
  });
});

test('code-rules-list: no warning once the reviewer is on; no file -> zero rules, no warning', () => {
  inTmp(() => {
    writeSpecFlow({ author: LEGACY, config: { phase: { codeReview: 'always' } } });
    const r = review['code-rules-list']({});
    assert.equal(r.data.count, 3);
    assert.deepEqual(r.data.warnings, []);
  });
  inTmp(() => {
    writeSpecFlow({ config: {} });
    const r = review['code-rules-list']({});
    assert.equal(r.data.count, 0);
    assert.deepEqual(r.data.warnings, []);
  });
});

test('review-scope: hands the reviewer the extracted rules as codeRules', () => {
  inTmp(() => {
    writeSpecFlow({ author: LEGACY, config: { phase: { codeReview: 'always' } } });
    fs.mkdirSync('.spec-flow/specs/demo', { recursive: true });
    fs.writeFileSync('.spec-flow/trace.json', JSON.stringify({ feature: 'demo' }));
    const r = review['review-scope']({ feature: 'demo' });
    assert.equal(r.ok, true);
    assert.equal(r.data.codeRules.length, 3);
    assert.equal(r.data.codeRules[1].id, 'R2');
  });
});

test('doctor: project-rules check warns RULES_REVIEWER_OFF', () => {
  inTmp(() => {
    writeSpecFlow({ author: LEGACY, config: { project: 'demo' } });
    const r = maintenance.doctor({});
    const c = r.data.checks.find((x) => x.name === 'project-rules');
    assert.ok(c, 'project-rules check present');
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /RULES_REVIEWER_OFF: 3 project rule/);
  });
});

test('contract: phase/bug pull rules from code-rules-list, never by hand', () => {
  const phaseMd = fs.readFileSync(path.join(root, 'commands/phase.md'), 'utf8');
  const bugMd = fs.readFileSync(path.join(root, 'commands/bug.md'), 'utf8');
  const executorMd = fs.readFileSync(path.join(root, 'agents/hybrid-executor.md'), 'utf8');
  assert.match(phaseMd, /flow-tools\.cjs code-rules-list/);
  assert.match(phaseMd, /review-scope → codeRules/);
  assert.match(bugMd, /flow-tools\.cjs code-rules-list/);
  assert.doesNotMatch(phaseMd, /extract the bullets under `## Code Rules`/);
  assert.doesNotMatch(bugMd, /extract the bullets under `## Code Rules`/);
  assert.match(executorMd, /rules beat the neighbouring code/);
});
