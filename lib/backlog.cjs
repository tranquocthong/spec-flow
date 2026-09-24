/**
 * backlog.cjs — shared backlog record helpers used by every backlog command
 * (`backlog-new`, `backlog-list`, `backlog-set`), plus `status` and `doctor`:
 * marker/legacy parsing, read-only listing, the sort comparator, and next-id
 * computation. Pure `fs` reads + string parsing — NEVER writes to disk. That
 * responsibility stays with the command bodies in bin/flow-tools.cjs (task 2+).
 *
 * Record format + field semantics: .spec-flow/specs/backlog-registry/SD.md
 * §7 Data Model, §10.3 (backlog-list flow). Priority/status scope is a
 * deliberate SUBSET of task-core.cjs's VALID_PRIORITIES/VALID_STATUSES — see
 * CONTEXT.md C-1/C-3 — so this module defines its own constants rather than
 * importing those.
 *
 * FR-004, FR-011, FR-012, FR-015, FR-026.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// SD §6.3 D2 — high|medium|low only, no `critical` (that's bug severity, not
// backlog scheduling priority).
const BACKLOG_VALID_PRIORITIES = ['high', 'medium', 'low'];
// SD §6.3 D3 — open|done|dropped only, a simpler lifecycle than task status.
const BACKLOG_VALID_STATUSES = ['open', 'done', 'dropped'];
// Presence of this marker line is what distinguishes a structured backlog
// record from a legacy free-form file (SD §7, CONTEXT C-4).
const BACKLOG_MARKER = '<!-- spec-flow backlog record -->';

// Sort rank per FR-011/§15 Glossary "Priority rank": high=0 ... unset=3 (last).
const PRIORITY_RANK = { high: 0, medium: 1, low: 2, unset: 3 };

/**
 * Parse ONE backlog file's content into the shared item shape (FR-012):
 * { id, title, priority, status, feature, epic, created, legacy }.
 * `path` is NOT set here — parseRecord only sees a filename, not a directory;
 * readRecords() adds it once it knows where the file actually lives.
 *
 * Marker records (BACKLOG_MARKER present) read `key: value` lines the same
 * way bug-list does. Legacy records (no marker, FR-015) fall back to:
 *   id       = filename without .md
 *   title    = first `# ` heading, with a leading "Backlog —"/"Backlog -"
 *              prefix stripped (harmless no-op on a marker record's plain
 *              title, since backlog-new never writes that prefix)
 *   priority = the `priority:` line's value IF it is one of
 *              BACKLOG_VALID_PRIORITIES, else 'unset'
 *   status   = the `status:` line's value IF it is one of
 *              BACKLOG_VALID_STATUSES, else 'open'
 * The same priority/status validation applies to marker records too — a
 * corrupted or hand-edited field must never surface as a bogus enum value.
 */
function parseRecord(filename, content) {
  const text = String(content || '');
  const legacy = !text.includes(BACKLOG_MARKER);

  const field = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };

  const headingMatch = text.match(/^#\s+(.+)$/m);
  const rawTitle = headingMatch ? headingMatch[1].trim() : filename.replace(/\.md$/, '');
  const title = rawTitle.replace(/^Backlog\s*[—-]\s*/, '');

  const priorityRaw = field('priority');
  const priority = BACKLOG_VALID_PRIORITIES.includes(priorityRaw) ? priorityRaw : 'unset';
  const statusRaw = field('status');
  const status = BACKLOG_VALID_STATUSES.includes(statusRaw) ? statusRaw : 'open';

  const id = legacy ? filename.replace(/\.md$/, '') : (field('id') || filename.replace(/\.md$/, ''));

  return {
    id,
    title,
    priority,
    status,
    feature: field('feature'),
    epic: field('epic'),
    created: field('created'),
    legacy,
  };
}

/**
 * Read every backlog record in `dir` (FR-012/FR-014/FR-016). Strictly
 * read-only — never writes, moves, or renames anything, including legacy
 * files (CONTEXT C-4, NFR-003). A missing dir is normal (feature unused yet)
 * and returns [] rather than an error.
 */
function readRecords(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return []; }

  const items = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    items.push({ ...parseRecord(f, content), path: p });
  }
  return items;
}

/**
 * Array.prototype.sort comparator implementing FR-011: priority
 * high > medium > low > unset, then `created` ascending (oldest first; an
 * item with no `created` sorts AFTER one that has it), then filename
 * (falls back to `id` when there is no `path`, e.g. comparator unit tests).
 */
function compareItems(a, b) {
  const ra = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.unset;
  const rb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.unset;
  if (ra !== rb) return ra - rb;

  const ca = a.created || null;
  const cb = b.created || null;
  if (ca && cb) {
    if (ca !== cb) return ca < cb ? -1 : 1;
  } else if (ca && !cb) {
    return -1;
  } else if (!ca && cb) {
    return 1;
  }

  const fa = a.path ? path.basename(a.path) : String(a.id || '');
  const fb = b.path ? path.basename(b.path) : String(b.id || '');
  if (fa < fb) return -1;
  if (fa > fb) return 1;
  return 0;
}

/**
 * Next NNN (zero-padded 3 digits) for `backlog-new` (FR-002/FR-003, CONTEXT
 * C-6): max numeric prefix among files matching `^(\d+)-bl-` in `dir`, plus
 * one. Mirrors bug-new's fix (commit 97c71df) — counting FILES instead of
 * taking the max prefix collides whenever the working tree is missing a
 * numbered file an unmerged branch already claimed. Files that don't match
 * the pattern (legacy files with no numeric prefix) are ignored. A missing
 * or empty dir yields '001'.
 */
function nextNum(dir) {
  let maxNum = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)-bl-/.exec(f);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch {}
  return String(maxNum + 1).padStart(3, '0');
}

module.exports = {
  BACKLOG_VALID_PRIORITIES,
  BACKLOG_VALID_STATUSES,
  BACKLOG_MARKER,
  parseRecord,
  readRecords,
  compareItems,
  nextNum,
};
