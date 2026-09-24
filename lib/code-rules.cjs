/**
 * code-rules.cjs — the rule engine behind `config.verify.rules` (SD §6, §10.1).
 *
 * This is a pure library: no CLI commands, no process.exit, no writes. verify-code
 * (lib/verify.cjs, task 2 of this feature) wires `evaluateRules` into its
 * `code-rules` check; `/sf:doctor` (a later task) will reuse `validateRules` to warn
 * on bad config before a real run ever happens.
 *
 * Why this exists (SRS): `forbiddenPatterns` scans the WHOLE `scanPath` on every
 * task, so adding one new pattern instantly fails every task whose code predates
 * it — which is why teams stop adding patterns. `config.verify.rules` defaults to
 * `scope: "diff"`: a `forbid` rule only turns pre-existing hits into a `preexisting`
 * count, and only NEW/CHANGED lines become blocking violations. `when`/`require`
 * lets a rule express "file has A ⇒ must also have B" (e.g. `@Scheduled` ⇒
 * `@SchedulerLock`), which a single-line regex cannot.
 *
 * Only two exports:
 *   validateRules(rules) -> { valid, warnings }
 *     Normalizes + compiles each raw rule config. A single bad rule (missing
 *     field, conflicting forbid+when, bad regex, bad scope, duplicate id) is
 *     dropped with a warning string (`RULE_INVALID: <id|index>` or
 *     `RULE_INVALID_REGEX: <id>`) — it NEVER throws (D4/NFR-003).
 *   evaluateRules({ rootDir, scanPath, rules, base }) -> { violations, preexisting,
 *                                                          warnings, skippedReason? }
 *     Computes the git diff scope (merge-base vs `base`, falling back to HEAD,
 *     falling back to "not a git repo" -> diff rules skipped) and scans
 *     `scanPath` for forbid/when-require hits, splitting each hit into
 *     `violations` (in scope) or a `preexisting` count (out of scope, informational
 *     only — never a blocker, per D1).
 *
 * Only side effect: spawning `git` (merge-base / diff / ls-files) with
 * `cwd: rootDir`. No network. No AST parsing (D3) — line/file regex only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SKIP_SCAN_DIRS } = require('./core.cjs');

// ---------------------------------------------------------------------------
// Glob matching — minimal, hand-rolled (no new dependency). Supports `**`
// (any number of path segments, including zero), `*` (anything but `/`), `?`
// (a single non-`/` char), and `{a,b,c}` alternation. Patterns are matched
// against a path relative to `rootDir` with forward slashes, regardless of
// platform, so `**/*Controller.java` matches both `FooController.java` (root)
// and `src/main/.../FooController.java` (nested).
// ---------------------------------------------------------------------------

function escapeRegexChar(c) {
  return /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume second '*'
        if (glob[i + 1] === '/') {
          i++; // consume the following '/' too
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = glob.slice(i + 1, end).split(',').map((s) => s.split('').map(escapeRegexChar).join(''));
        re += '(?:' + alts.join('|') + ')';
        i = end;
      }
    } else {
      re += escapeRegexChar(c);
    }
  }
  return new RegExp('^' + re + '$');
}

function globArrayMatches(relPath, patterns) {
  return patterns.some((p) => {
    try { return globToRegExp(p).test(relPath); } catch { return false; }
  });
}

function normalizeGlobField(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.length > 0) return [v];
  if (Array.isArray(v)) {
    const list = v.filter((x) => typeof x === 'string' && x.length > 0);
    return list.length ? list : null;
  }
  return null;
}

/** Default (no `glob` given): every file under scanPath EXCEPT `.md` (D-non-goal). */
function fileMatchesRule(relPath, rule) {
  if (rule.exclude && globArrayMatches(relPath, rule.exclude)) return false;
  if (rule.glob === null) return !/\.md$/i.test(relPath);
  return globArrayMatches(relPath, rule.glob);
}

// ---------------------------------------------------------------------------
// Rule validation (FR-001, D4). Never throws — a bad rule is dropped with a
// warning and the rest of the array still runs.
// ---------------------------------------------------------------------------

/**
 * @param {Array} rules  raw `config.verify.rules` array (untrusted input)
 * @returns {{ valid: Array, warnings: string[] }}
 */
function validateRules(rules) {
  const valid = [];
  const warnings = [];
  if (!Array.isArray(rules)) return { valid, warnings };

  const seenIds = new Set();

  rules.forEach((rule, idx) => {
    const idxLabel = String(idx);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      warnings.push(`RULE_INVALID: ${idxLabel}`);
      return;
    }
    const hasId = typeof rule.id === 'string' && rule.id.trim() !== '';
    const label = hasId ? rule.id : idxLabel;
    if (!hasId) { warnings.push(`RULE_INVALID: ${label}`); return; }
    if (seenIds.has(rule.id)) { warnings.push(`RULE_INVALID: ${label}`); return; }
    if (typeof rule.message !== 'string' || rule.message.trim() === '') {
      warnings.push(`RULE_INVALID: ${label}`); return;
    }

    const hasForbid = rule.forbid !== undefined && rule.forbid !== null && rule.forbid !== '';
    const hasWhen = rule.when !== undefined && rule.when !== null && rule.when !== '';
    const hasRequire = rule.require !== undefined && rule.require !== null && rule.require !== '';

    // Exactly one of forbid OR when(+require).
    if (hasForbid === hasWhen) { warnings.push(`RULE_INVALID: ${label}`); return; }
    if (hasWhen && !hasRequire) { warnings.push(`RULE_INVALID: ${label}`); return; }

    const scopeVal = rule.scope === undefined ? 'diff' : rule.scope;
    if (scopeVal !== 'diff' && scopeVal !== 'all') { warnings.push(`RULE_INVALID: ${label}`); return; }

    let forbidRe = null;
    let whenRe = null;
    let requireRe = null;
    try {
      if (hasForbid) forbidRe = new RegExp(rule.forbid);
      if (hasWhen) whenRe = new RegExp(rule.when);
      if (hasRequire) requireRe = new RegExp(rule.require);
    } catch {
      warnings.push(`RULE_INVALID_REGEX: ${label}`);
      return;
    }

    seenIds.add(rule.id);
    valid.push({
      id: rule.id,
      message: rule.message,
      glob: normalizeGlobField(rule.glob),
      exclude: normalizeGlobField(rule.exclude),
      forbid: forbidRe,
      when: whenRe,
      require: requireRe,
      scope: scopeVal,
    });
  });

  return { valid, warnings };
}

// ---------------------------------------------------------------------------
// git plumbing (FR-002). Every call is defensive: a missing git binary, a
// non-repo cwd, or a missing ref returns null/empty rather than throwing.
// ---------------------------------------------------------------------------

function git(args, rootDir) {
  const r = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  return r.stdout || '';
}

function isGitRepo(rootDir) {
  const out = git(['rev-parse', '--is-inside-work-tree'], rootDir);
  return out !== null && out.trim() === 'true';
}

/** Parse `git diff -U0` hunk headers into per-file sets of added/modified line numbers. */
function parseUnifiedDiff(diffText, addedLines, changedFiles) {
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') { currentFile = null; continue; }
      currentFile = p.replace(/^b\//, '');
      changedFiles.add(currentFile);
      if (!addedLines.has(currentFile)) addedLines.set(currentFile, new Set());
      continue;
    }
    if (line.startsWith('@@') && currentFile) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        const startLine = parseInt(m[1], 10);
        const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        if (count > 0) {
          const set = addedLines.get(currentFile);
          if (set !== 'ALL') {
            for (let ln = startLine; ln < startLine + count; ln++) set.add(ln);
          }
        }
      }
    }
  }
}

/**
 * Resolve the diff scope: which lines/files are "new" for `forbid`/`when-require`.
 *   - `base` resolves via `git merge-base <base> HEAD` -> diff that commit vs the
 *     working tree (`git diff -U0`, so uncommitted changes are included).
 *   - `base` missing/unresolvable (no config, ref gone) -> fall back to a diff
 *     against HEAD + warning `RULE_DIFF_BASE_UNAVAILABLE` (SD §12.2).
 *   - Not a git repo at all -> `available: false`; diff-scoped rules are skipped
 *     entirely by the caller (only `scope: "all"` rules can still run).
 *   - Untracked files (`git ls-files --others --exclude-standard`) count every
 *     line as added — they never show up in `git diff <ref>` output.
 */
function computeDiffScope(rootDir, base) {
  if (!isGitRepo(rootDir)) {
    return {
      available: false,
      addedLines: new Map(),
      changedFiles: new Set(),
      warnings: ['RULE_DIFF_BASE_UNAVAILABLE: not a git repository'],
    };
  }

  const warnings = [];
  let mergeBase = null;
  if (base) {
    const mb = git(['merge-base', base, 'HEAD'], rootDir);
    if (mb) mergeBase = mb.trim();
  }
  let diffTarget = mergeBase;
  if (!diffTarget) {
    warnings.push('RULE_DIFF_BASE_UNAVAILABLE');
    diffTarget = 'HEAD';
  }

  const addedLines = new Map();
  const changedFiles = new Set();
  const diffOut = git(['diff', '-U0', '--no-color', diffTarget], rootDir);
  if (diffOut) parseUnifiedDiff(diffOut, addedLines, changedFiles);

  const untracked = git(['ls-files', '--others', '--exclude-standard'], rootDir) || '';
  for (const rel of untracked.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    changedFiles.add(rel);
    addedLines.set(rel, 'ALL');
  }

  return { available: true, addedLines, changedFiles, warnings };
}

function isLineAdded(diffScope, relPath, lineNo) {
  const v = diffScope.addedLines.get(relPath);
  if (v === undefined) return false;
  if (v === 'ALL') return true;
  return v.has(lineNo);
}

// ---------------------------------------------------------------------------
// File walk + safe read (mirrors lib/verify.cjs's forbiddenPatterns walker).
// ---------------------------------------------------------------------------

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(ent.name)) continue;
        stack.push(path.join(d, ent.name));
      } else if (ent.isFile()) {
        out.push(path.join(d, ent.name));
      }
    }
  }
  return out;
}

/** Returns file content as a string, or null if binary / not valid UTF-8 (TC-014). */
function readTextFile(absPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return null; }
  const sample = buf.length > 8000 ? buf.subarray(0, 8000) : buf;
  if (sample.includes(0)) return null; // NUL byte -> binary
  const text = buf.toString('utf8');
  // Re-encoding a valid UTF-8 buffer round-trips to the same byte length; a
  // buffer with invalid sequences gets U+FFFD replacement chars and diverges.
  if (Buffer.byteLength(text, 'utf8') !== buf.length) return null;
  return text;
}

// ---------------------------------------------------------------------------
// evaluateRules — the main entry point (FR-002, FR-003).
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.rootDir   git repo root (cwd for every git subprocess)
 * @param {string} [opts.scanPath] directory to scan, relative to rootDir (default '.')
 * @param {Array}  opts.rules     raw config.verify.rules
 * @param {string} [opts.base]    config.branching.base (merge-base target)
 * @returns {{ violations: Array, preexisting: number, warnings: string[], skippedReason?: string }}
 */
function evaluateRules({ rootDir, scanPath = '.', rules, base } = {}) {
  const { valid, warnings } = validateRules(rules);

  if (valid.length === 0) {
    return { violations: [], preexisting: 0, warnings, skippedReason: 'NO_VALID_RULES' };
  }

  const diffRules = valid.filter((r) => r.scope === 'diff');
  const allRules = valid.filter((r) => r.scope === 'all');

  let diffScope = { available: false, addedLines: new Map(), changedFiles: new Set() };
  if (diffRules.length > 0) {
    diffScope = computeDiffScope(rootDir, base);
    warnings.push(...diffScope.warnings);
  }

  // Not a git repo at all -> drop diff-scoped rules entirely (D4: never crash,
  // never fail the gate on missing infra). `scope: "all"` rules are unaffected.
  const effectiveRules = diffScope.available ? diffRules.concat(allRules) : allRules;
  if (effectiveRules.length === 0) {
    return { violations: [], preexisting: 0, warnings, skippedReason: 'NO_APPLICABLE_RULES' };
  }

  const absScanPath = path.isAbsolute(scanPath) ? scanPath : path.join(rootDir, scanPath);
  const files = fs.existsSync(absScanPath) ? walkFiles(absScanPath) : [];

  const violations = [];
  let preexisting = 0;

  for (const absPath of files) {
    const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
    let content = null; // lazy-read: only once a rule's glob actually matches

    for (const rule of effectiveRules) {
      if (!fileMatchesRule(relPath, rule)) continue;
      if (content === null) {
        content = readTextFile(absPath);
        if (content === null) break; // binary/non-UTF8 -> skip this file for every rule
      }
      const lines = content.split(/\r?\n/);

      if (rule.forbid) {
        // scope "diff": scan the WHOLE file (not just changed files) so that an
        // untouched file's old hits still count into `preexisting` (TC-002) —
        // only the specific added/modified LINES become blocking violations.
        for (let i = 0; i < lines.length; i++) {
          if (!rule.forbid.test(lines[i])) continue;
          const lineNo = i + 1;
          const inScope = rule.scope === 'all' || isLineAdded(diffScope, relPath, lineNo);
          if (inScope) {
            violations.push({ rule: rule.id, file: relPath, line: lineNo, text: lines[i].trim().slice(0, 200), message: rule.message });
          } else {
            preexisting++;
          }
        }
      } else if (rule.when) {
        // File-level: violation if the file has a `when` line and no `require`
        // line anywhere. Report at the first `when` line (FR-001).
        let firstWhenLine = null;
        let firstWhenLineNo = null;
        let hasRequireMatch = false;
        for (let i = 0; i < lines.length; i++) {
          if (firstWhenLine === null && rule.when.test(lines[i])) {
            firstWhenLine = lines[i];
            firstWhenLineNo = i + 1;
          }
          if (!hasRequireMatch && rule.require.test(lines[i])) hasRequireMatch = true;
        }
        if (firstWhenLine !== null && !hasRequireMatch) {
          const inScope = rule.scope === 'all' || diffScope.changedFiles.has(relPath);
          if (inScope) {
            violations.push({ rule: rule.id, file: relPath, line: firstWhenLineNo, text: firstWhenLine.trim().slice(0, 200), message: rule.message });
          } else {
            preexisting++;
          }
        }
      }
    }
  }

  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  return { violations, preexisting, warnings };
}

module.exports = {
  validateRules,
  evaluateRules,
  // Exposed for direct unit testing of the glob engine (not part of the CLI/verify
  // contract — verify.cjs only ever calls validateRules/evaluateRules).
  _internal: { globToRegExp, fileMatchesRule, normalizeGlobField },
};
