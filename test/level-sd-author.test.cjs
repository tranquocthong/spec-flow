'use strict';
// sd-author prompt contract: Pass-2 assigns one Level per TC (FR-004), resync only
// reassigns Level for TCs of changed FRs (FR-005), and the policy text stays
// stack-agnostic (D6 / TC-020).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROMPT = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sd-author.md'), 'utf8');

const FRAMEWORKS = /spring|junit|jest|pytest|mockito|webflux|flyway|testcontainers/i;

// Section B body: from "### B." up to "### C."
function sectionB() {
  const start = PROMPT.search(/^### B\. /m);
  assert.ok(start >= 0, 'section B not found');
  const rest = PROMPT.slice(start);
  const end = rest.search(/^### C\. /m);
  assert.ok(end > 0, 'section C not found');
  return rest.slice(0, end);
}

test('sd-author: section B documents the Level column with all four values', () => {
  const b = sectionB();
  assert.match(b, /\bLevel\b/);
  for (const v of ['unit', 'slice', 'it', 'live']) {
    assert.match(b, new RegExp('`' + v + '`'), `value ${v} missing in section B`);
  }
  assert.match(b, /unit\s*\|\s*slice\s*\|\s*it\s*\|\s*live/);
});

test('sd-author: Level is the LAST column of the 7-column 13.2 table', () => {
  const header = '| TC ID | Flow | Test Case | Input / Condition | Expected Result | FR | Level |';
  assert.ok(PROMPT.includes(header), 'the 7-column header with Level last is missing');
  // No stale 6-column header left behind.
  assert.ok(!PROMPT.includes('| Expected Result | FR |`'), 'stale 6-column header still present');
  assert.match(PROMPT, /last column/i);
});

test('sd-author: points at sd-template 13.1 and says cheapest level wins', () => {
  const b = sectionB();
  assert.match(b, /13\.1/);
  assert.match(b, /cheapest/i);
});

test('sd-author: lists the five `it` categories', () => {
  const b = sectionB();
  assert.match(b, /query\s*\/\s*repository/i);
  assert.match(b, /index/i);
  assert.match(b, /lock/i);
  assert.match(b, /money flow/i);
  assert.match(b, /idempotency/i);
  assert.match(b, /concurrent/i);
  assert.match(b, /event contract/i);
  assert.match(b, /security wiring/i);
  assert.match(b, /one case per (rule type|rule)/i);
  assert.match(b, /schema migration/i);
});

test('sd-author: unit and live triggers are described', () => {
  const b = sectionB();
  assert.match(b, /validation/i);
  assert.match(b, /mapping/i);
  assert.match(b, /error code/i);
  assert.match(b, /routing|middleware/i);
  assert.match(b, /deployed system/i);
  assert.match(b, /cross-service/i);
});

test('sd-author: exactly one Level per TC, never empty, English tokens', () => {
  const b = sectionB();
  assert.match(b, /exactly one Level/i);
  assert.match(b, /never (leave|empty)[^\n]*(empty|blank)|never empty/i);
  assert.match(b, /English/);
  assert.match(b, /Pass-1[^\n]*`unit`|`unit`[^\n]*Pass-1/);
  assert.match(b, /reassign/i);
});

test('sd-author: resync reassigns Level only for TCs of changed FRs', () => {
  const b = sectionB();
  assert.match(b, /resync/i);
  assert.match(b, /only[^\n]*(TCs?|test cases?)[^\n]*(changed|impacted|affected) FR/i);
  assert.match(b, /(keep|keeps|untouched|unchanged)/i);
});

test('sd-author: language rule keeps Level header and tokens in English', () => {
  const lang = PROMPT.slice(PROMPT.search(/^## LANGUAGE/m), PROMPT.search(/^## Inputs/m));
  assert.match(lang, /Level/);
});

test('sd-author: Level guidance names no framework or tool (D6 / TC-020)', () => {
  const b = sectionB();
  assert.doesNotMatch(b, FRAMEWORKS);
  // The whole prompt is currently clean; keep it that way.
  assert.doesNotMatch(PROMPT, FRAMEWORKS);
});
