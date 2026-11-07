'use strict';
/**
 * sd-slice.cjs — cut an SD down to what ONE task needs.
 *
 * Why: /sf:phase spawns a fresh hybrid-executor per task, and each one used to
 * read the whole SD (often 1,000+ lines on a full-detail SD) to find the two or
 * three FR rows it implements. Across a 10-task phase that is the single
 * largest repeated read. The slice keeps the binding rows verbatim and replaces
 * everything else with a line-numbered outline, so the executor can still open
 * any other section (a sequence diagram, a state table) by line range.
 *
 * Pure: no fs, no process. The command wrapper (sd-slice in flow-tools.cjs)
 * resolves the task text and trace links and hands the ids in.
 *
 * What is kept, verbatim (original lines, never re-rendered):
 *   - every table row that mentions a wanted id (FR-/TC-/NFR-/D… ids), plus the
 *     table header; a kept TC row's own id joins the wanted set once (a TC row
 *     naming FR-001 pulls TC-007 in, so rows citing TC-007 follow);
 *   - rows of any "Error Code" table whose code appears in the kept text;
 *   - a whole leaf block (heading level >= 4: one endpoint, one table
 *     definition, one sequence flow) that mentions a wanted id, capped;
 *   - any other prose line that mentions a wanted id, under its heading.
 * Fenced code (mermaid diagrams) is never cut line by line — only whole, as part
 * of a leaf block.
 */

const ID_RE = /\b(?:FR|TC|NFR)-\d+\b/gi;
const LEAF_BLOCK_MAX_LINES = 120;

const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSepLine = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

function firstCell(line) {
  const m = /^\s*\|([^|]*)\|/.exec(line);
  return m ? m[1].replace(/[`*]/g, '').trim() : '';
}

function mentions(text, ids) {
  for (const m of String(text).matchAll(ID_RE)) if (ids.has(m[0].toUpperCase())) return true;
  return false;
}

/** Headings with 0-based line ranges [start, end). */
function outlineOf(lines) {
  const hs = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) hs.push({ level: m[1].length, title: m[2].trim(), start: i });
  });
  hs.forEach((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < hs.length; j++) if (hs[j].level <= h.level) { end = hs[j].start; break; }
    h.end = end;
  });
  return hs;
}

/**
 * @param {string} sdText
 * @param {Iterable<string>} seedIds   FR/TC ids the task covers (any case)
 * @param {object} [opts]
 * @param {number} [opts.outlineMaxLevel=3]
 * @returns {{ ids: string[], found: string[], missing: string[], errorCodes: string[],
 *             keptLines: number, sdLines: number, markdown: string, outline: object[] }}
 */
function sliceSd(sdText, seedIds, opts = {}) {
  const outlineMaxLevel = opts.outlineMaxLevel || 3;
  const lines = String(sdText || '').split(/\r?\n/);
  const ids = new Set([...seedIds].map((s) => String(s).toUpperCase()));
  const seed = new Set(ids);
  const headings = outlineOf(lines);

  // ---- index tables and fences --------------------------------------------
  const inFence = new Array(lines.length).fill(false);
  {
    let f = false;
    lines.forEach((l, i) => {
      if (/^\s*```/.test(l)) { inFence[i] = true; f = !f; return; }
      inFence[i] = f;
    });
  }
  const tables = []; // { header, sep, rows: [lineIdx], isError }
  const tableLine = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i] || !isTableLine(lines[i]) || !isSepLine(lines[i + 1] || '')) continue;
    const t = { header: i, sep: i + 1, rows: [], isError: /error\s*code/i.test(lines[i]) };
    tableLine[i] = tableLine[i + 1] = true;
    let j = i + 2;
    while (j < lines.length && isTableLine(lines[j])) { t.rows.push(j); tableLine[j] = true; j++; }
    tables.push(t);
    i = j - 1;
  }

  const keep = new Set();
  const keepTableRow = (t, r) => { keep.add(t.header); keep.add(t.sep); keep.add(r); };

  // ---- pass 1 + expansion: table rows that mention a wanted id ---------------
  for (let pass = 0; pass < 2; pass++) {
    const grown = [];
    for (const t of tables) {
      if (t.isError) continue;
      for (const r of t.rows) {
        if (!mentions(lines[r], ids)) continue;
        keepTableRow(t, r);
        const fc = firstCell(lines[r]).toUpperCase();
        // Only TC ids grow the set: a TC row naming a wanted FR is that FR's
        // acceptance test. An NFR/FR row merely citing a range ("FR-006 to
        // FR-011") is kept but must not drag its own TCs in.
        if (/^TC-\d+$/.test(fc) && !ids.has(fc)) grown.push(fc);
      }
    }
    if (!grown.length) break;
    // Only the first expansion step: a TC row naming a seed FR pulls the TC in;
    // we do not chase the TC's other FRs (that would walk the whole graph).
    if (pass === 0) grown.forEach((g) => ids.add(g));
  }

  // ---- leaf blocks (level >= 4) mentioning a wanted id -----------------------
  for (const h of headings) {
    if (h.level < 4) continue;
    const body = lines.slice(h.start, h.end).join('\n');
    if (!mentions(body, ids)) continue;
    const end = Math.min(h.end, h.start + LEAF_BLOCK_MAX_LINES);
    for (let i = h.start; i < end; i++) keep.add(i);
  }

  // ---- loose prose lines -----------------------------------------------------
  for (let i = 0; i < lines.length; i++) {
    if (tableLine[i] || inFence[i] || keep.has(i)) continue;
    if (/^#{1,6}\s/.test(lines[i])) continue;
    if (mentions(lines[i], ids)) keep.add(i);
  }

  // ---- error codes referenced by anything kept -------------------------------
  const keptText = [...keep].map((i) => lines[i]).join('\n');
  const errorCodes = [];
  for (const t of tables) {
    if (!t.isError) continue;
    for (const r of t.rows) {
      const code = firstCell(lines[r]);
      if (!code || !/^[A-Z][A-Z0-9_.-]{2,}$/.test(code)) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_])${code.replace(/[.-]/g, '\\$&')}([^A-Za-z0-9_]|$)`);
      if (re.test(keptText) || mentions(lines[r], ids)) { keepTableRow(t, r); errorCodes.push(code); }
    }
  }

  // ---- render ----------------------------------------------------------------
  // Heading trail: for each kept line, the chain of headings that encloses it.
  const enclosing = (i) => headings.filter((h) => h.start <= i && i < h.end);
  const out = [];
  const printed = new Set();
  const sorted = [...keep].sort((a, b) => a - b);
  let prev = -2;
  for (const i of sorted) {
    for (const h of enclosing(i)) {
      if (printed.has(h.start) || h.start === i) continue;
      printed.add(h.start);
      out.push('', lines[h.start], '');
      prev = -2;
    }
    const isHeading = headings.some((h) => h.start === i);
    if (isHeading) { printed.add(i); out.push(''); }
    else if (prev >= 0 && i !== prev + 1 && !(tableLine[i] && tableLine[prev])) out.push('');
    out.push(lines[i]);
    prev = i;
  }

  const rendered = out.join('\n').replace(/\n{3,}/g, '\n\n');
  const found = [...seed].filter((id) => new RegExp(`\\b${id}\\b`, 'i').test(rendered));
  const missing = [...seed].filter((id) => !found.includes(id));
  const outline = headings
    .filter((h) => h.level <= outlineMaxLevel)
    .map((h) => ({ level: h.level, title: h.title, from: h.start + 1, to: h.end }));

  return {
    ids: [...ids],
    found,
    missing,
    errorCodes,
    keptLines: keep.size,
    sdLines: lines.length,
    markdown: rendered.replace(/^\n+/, ''),
    outline,
  };
}

/** Pull FR/TC ids out of free task text (title, details, testStrategy, subtasks). */
function idsFromText(text) {
  return [...new Set((String(text || '').match(ID_RE) || []).map((s) => s.toUpperCase()))];
}

module.exports = { sliceSd, idsFromText, outlineOf };
