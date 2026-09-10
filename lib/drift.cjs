/**
 * drift.cjs — Layer-2 SEMANTIC drift-check (SD-mismatch defense).
 *
 * The structural `sd-drift-detect` hook only checks file-in-trace / FR-has-TC. THIS is
 * the semantic layer: it diffs the error codes that ACTUALLY EXIST IN THE SOURCE against
 * what the SD SPECIFIES (§12.2, via the trace) — surfacing SD-mismatch BEFORE it ships.
 *
 * The primary source is the CODE (config.verify.scanPath), scanned deterministically with
 * no AI op and no dependence on what an agent chose to write down. Task logs from
 * `update-task --append` are merged in as a SECONDARY source when present, but they are
 * no longer required: that op is opt-in since config.phase.taskNotes landed, and it was
 * in fact broken for its entire life (the documented `--id=<id>` form was rejected by the
 * CLI), so a log-only drift-check answered clean:true having read nothing at all.
 * With NO source available the answer is clean:null (undetermined) — never a false clean.
 *
 * Scope (v1): §12.2 error codes — the high-signal, deterministically-extractable contract
 * element. §9.2 field names and §10.4 state transitions are left to future work: their
 * "actual" form in free-prose task logs is too noisy to diff deterministically without
 * false positives. Error codes (and the configured errorCodePattern) are precise tokens.
 *
 * HONEST framing: a code absent from the scanned source means "not found where we looked".
 * Multi-repo features and code outside scanPath are genuinely out of view, so the hint says
 * where it searched. Advisory only, never blocks.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PATHS, SKIP_SCAN_DIRS, ok, err, readJsonSafe, readTrace, readTmTasks, resolveRepos } = require('./core.cjs');

/** Recursively collect text-file contents under `root`, skipping vendor/build dirs. */
function scanSource(root, maxBytes = 8 * 1024 * 1024) {
  const out = [];
  let budget = maxBytes;
  const skip = new Set(SKIP_SCAN_DIRS || []);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(full); continue; }
      if (!/\.(js|cjs|mjs|ts|tsx|jsx|java|kt|py|go|rb|cs|php|rs|scala|sql|ya?ml|json|properties|xml)$/i.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > budget) continue;
        out.push(fs.readFileSync(full, 'utf8'));
        budget -= st.size;
      } catch { /* unreadable: skip */ }
    }
  };
  walk(root);
  return out.join('\n');
}

module.exports = {
  // -----------------------------------------------------------------------
  // drift-check  [--feature <f>] [--tasks <tasks.json>]
  // Diff SD §12.2 error codes vs the executor's implementation logs in tasks.json.
  // Returns ok({ specifiedErrorCodes, evidencedErrorCodes, implOnlyErrorCodes, drift[], clean }).
  // NEVER blocks — drift[] is advisory (surfaced by /sf:phase before next_task).
  // -----------------------------------------------------------------------
  'drift-check'(args) {
    const feature = args.feature || (readJsonSafe(PATHS.trace, null) || {}).feature || null;
    const trace = readTrace(feature);
    if (!trace) return err('NO_TRACE: run trace-build first');
    const errorNodes = (trace.nodes && trace.nodes.errors) || [];

    // ---- Sources of "what actually exists" -------------------------------
    // PRIMARY: the code under config.verify.scanPath. Deterministic, no AI op, and
    // independent of whether any agent bothered to write a note.
    const cfg = readJsonSafe(PATHS.config, {}) || {};
    const scanPath = (cfg.verify && cfg.verify.scanPath) || '.';

    // SCOPE: prefer the files THIS feature actually wrote, recorded by trace-link in
    // file-links.json. Scanning the whole scanPath instead reports every error code in
    // the repo as "undocumented by this SD" — on spec-flow's own repo that produced 39
    // impl-not-specced entries belonging to other features. The log-based predecessor
    // was scoped by accident (it only ever read this feature's task notes); scoping by
    // file-links makes that explicit and keeps it accurate.
    const flPath = path.join(PATHS.specs, feature || '', 'file-links.json');
    const fl = feature && fs.existsSync(flPath) ? readJsonSafe(flPath, null) : null;
    const touched = fl && Array.isArray(fl.links)
      ? [...new Set(fl.links.map(l => String(l && l.file || '')).filter(Boolean))]
      : [];

    let narrowText = '';
    let scopeNote = '';
    if (touched.length) {
      // Multi-repo: trace-link stores paths repo-qualified ("svc-a/src/x.js") and the
      // code lives in a SIBLING checkout, so the first segment must be resolved through
      // config.repos. Without this every multi-repo feature scanned nothing and fell
      // back to task logs — the exact case that matters most, since a hub repo holds no
      // service code at all.
      const repoRoots = new Map();
      for (const r of resolveRepos(cfg)) { if (r.name) repoRoots.set(r.name, r.root); }
      const parts = [];
      for (const rel of touched) {
        const seg = rel.split('/');
        const cands = [];
        if (seg.length > 1 && repoRoots.has(seg[0])) {
          cands.push(path.resolve(repoRoots.get(seg[0]), seg.slice(1).join('/')));
        }
        cands.push(path.resolve(process.cwd(), rel));
        if (seg.length > 1) cands.push(path.resolve(process.cwd(), seg.slice(1).join('/')));
        for (const abs of cands) {
          try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
              parts.push(fs.readFileSync(abs, 'utf8'));
              break;
            }
          } catch { /* skip */ }
        }
      }
      narrowText = parts.join('\n');
      scopeNote = `${parts.length}/${touched.length} file(s) from file-links`;
    }

    // WIDE scope: scanPath in this repo plus every configured sibling repo. Used ONLY
    // to prove ABSENCE. The two drift directions need opposite scopes:
    //   spec-not-evidenced — "SD declares X, the code doesn't have it". Absence must be
    //     PROVEN, so a narrow search cannot decide it: file-links stores are routinely
    //     incomplete (verified on a shipped feature whose §12.2 code sat in 4 files that
    //     its own 28-entry file-links never recorded — narrow scope called it missing).
    //   impl-not-specced  — "the code has Y, the SD doesn't declare it". Only code THIS
    //     feature wrote is relevant, so a wide search would attribute every neighbouring
    //     feature's codes to this one (39 such entries on spec-flow's own repo).
    const wideRoots = [];
    const scanRootHere = path.resolve(process.cwd(), scanPath);
    if (fs.existsSync(scanRootHere)) wideRoots.push(scanRootHere);
    for (const r of resolveRepos(cfg)) {
      if (!r.name || !r.root) continue;
      for (const cand of [path.join(r.root, scanPath), r.root]) {
        if (fs.existsSync(cand)) { wideRoots.push(cand); break; }
      }
    }
    let wideText = '';
    for (const root of wideRoots) wideText += '\n' + scanSource(root);

    // With no file-links yet, the wide scan is the only source of "what exists".
    const sourceText = narrowText.trim() || wideText.trim();
    if (!narrowText.trim() && wideText.trim()) scopeNote = `scanPath "${scanPath}" (no file-links yet)`;

    // SECONDARY: task logs, when they happen to exist (taskNotes is opt-in).
    const tasksFile = args.tasks || path.join(process.cwd(), '.taskmaster', 'tasks', 'tasks.json');
    const tasks = readTmTasks(readJsonSafe(tasksFile, null), feature);
    const logParts = [];
    for (const t of tasks) {
      if (t && t.details) logParts.push(String(t.details));
      for (const st of (t && t.subtasks) || []) { if (st && st.details) logParts.push(String(st.details)); }
    }
    const implLog = logParts.join('\n');

    const lc = (x) => String(x).toLowerCase();
    // Narrow haystack: what THIS feature wrote (+ its own logs) -> impl-not-specced.
    const narrowLc = ((narrowText.trim() || wideText) + '\n' + implLog).toLowerCase();
    // Wide haystack: everything reachable -> decides spec-not-evidenced (absence).
    const wideLc = (wideText + '\n' + narrowText + '\n' + implLog).toLowerCase();
    const haystack = (narrowText.trim() || wideText) + '\n' + implLog;

    const sdCodes = errorNodes.map((n) => String(n.code || '').replace(/`/g, '').trim()).filter(Boolean);

    // NOTHING to compare against → UNDETERMINED, not clean. A log-only drift-check
    // used to answer clean:true here having read nothing, which is a false negative.
    if (!sourceText.trim() && !wideText.trim() && !implLog.trim()) {
      return ok({
        feature, specifiedErrorCodes: sdCodes, evidencedErrorCodes: [], implOnlyErrorCodes: [],
        drift: [], clean: null,
        note: `UNDETERMINED: nothing to scan — this feature has no file-links yet and config.verify.scanPath ("${scanPath}") holds no readable source. Implement some tasks first, or set scanPath.`,
      });
    }

    // Extract impl error-code tokens: the configured prefix (default ERR_), plus the
    // project's errorCodePattern when set (so non-ERR_ schemes like WALLET-4001 are caught).
    const conv = cfg.conventions || {};
    const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRes = [new RegExp('\\b' + esc(conv.errorCodePrefix || 'ERR_') + '[A-Za-z0-9_]+\\b', 'g')];
    if (conv.errorCodePattern) { try { tokenRes.push(new RegExp(conv.errorCodePattern.replace(/^\^/, '').replace(/\$$/, ''), 'g')); } catch { /* invalid pattern: skip */ } }
    // impl-not-specced candidates come from the NARROW scope only.
    const narrowSrc = (narrowText.trim() || wideText) + '\n' + implLog;
    const implCodes = new Set();
    for (const re of tokenRes) { let m; while ((m = re.exec(narrowSrc)) !== null) implCodes.add(m[0]); }

    const sdLcSet = new Set(sdCodes.map(lc));
    const where = sourceText.trim()
      ? `scanned ${scopeNote || `scanPath "${scanPath}"`}${implLog.trim() ? ' + task logs' : ''}; absence checked against ${wideRoots.length} wide root(s)`
      : 'scanned task logs only (no source found)';
    const drift = [];
    // (1) SD-specified error code that exists nowhere we looked.
    for (const c of sdCodes) {
      if (!wideLc.includes(lc(c))) {
        drift.push({ type: 'spec-not-evidenced', code: c, hint: `SD §12.2 defines ${c} and it appears nowhere in ${wideRoots.length} scanned root(s) — implement it, or remove it from §12.2.` });
      }
    }
    // (2) Error code present in the code that §12.2 doesn't document.
    for (const c of implCodes) {
      if (!sdLcSet.has(lc(c))) {
        drift.push({ type: 'impl-not-specced', code: c, hint: `${c} appears in the code but SD §12.2 doesn't document it — add it to §12.2, or change the code to the spec'd one.` });
      }
    }

    return ok({
      feature,
      specifiedErrorCodes: sdCodes,
      evidencedErrorCodes: sdCodes.filter((c) => wideLc.includes(lc(c))),
      implOnlyErrorCodes: [...implCodes].filter((c) => !sdLcSet.has(lc(c))),
      drift,
      clean: drift.length === 0,
      source: sourceText.trim() ? (scopeNote.includes('file-links') ? 'code(file-links)' : 'code(scanPath)') + (implLog.trim() ? '+logs' : '') : 'logs',
      note: `Layer-2 error-code drift (advisory, ${where}). §9.2 field / §10.4 state drift not yet covered.`,
    });
  },
};
