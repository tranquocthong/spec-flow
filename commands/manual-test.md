---
description: "Run the feature's CHECKLIST.yaml (smoke → regression) and record VERIFICATION."
argument-hint: "<feature> [--smoke-only] [--regression-only]"
allowed-tools: Read, Bash
---

# /sf:manual-test — run checklist + record verification

Runs `.spec-flow/specs/<feature>/CHECKLIST.yaml` through the bundled runner, then records the result in `VERIFICATION.md`.

Input: `$ARGUMENTS` — feature name (required). Flags:
- `--smoke-only` — run only smoke-tagged tests (fast pre-check).
- `--regression-only` — skip smoke, run full regression suite only.

## Steps

1. Resolve the feature name and checklist path.
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs status-report --feature <feature>
   ```
   Confirm `data.checklist` is `ready` (no TODO markers). If it says `scaffold (N TODO)` — stop and tell the user: "Checklist still has unfilled tests. Fill them first (see `/sf:checklist`)."

   Environment: the runner sources `.spec-flow/specs/<feature>/run/env.sh` when it exists
   (`NAME=value` lines — `export` optional — for tokens, DB user, fixture ids; `run/` is
   git-ignored automatically) and stops with a list of missing variables before running
   anything. Fill that file instead of exporting by hand. No local `psql`? Set
   `manualTest.psql` in `.spec-flow/config.json` (see the skill's `references/checklist.md`).

2. **Smoke run** (unless `--regression-only`):
   ```bash
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag smoke --json
   ```
   Capture output. If any test FAILs → report failures, stop. Do NOT proceed to regression on a failing smoke.

3. **Regression run** (unless `--smoke-only`):
   ```bash
   scripts/run-checklist.sh .spec-flow/specs/<feature>/CHECKLIST.yaml --tag regression --json
   ```
   Capture the final JSON result line `{passed, failed, skipped, ...}`.

   After fixing failures, rerun only those: add `--rerun-failed` (reads and merges back into
   `run/last-result.json`). Do not rerun the whole suite to check one fix.

4. **Record result** via verify-collect:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs verify-collect --feature <feature> --results <json-result-line>
   ```
   After a `--rerun-failed`, pass the merged file instead of the last line, so the record
   covers every test: `--results .spec-flow/specs/<feature>/run/last-result.json`.
   This writes `VERIFICATION.md`. If all passed → status `passed`. If any failed → status `failed` with failure list.
   When the result line carries `tests` rows, it also writes a `## Summary` with per-suite (and per-evidence) counts. Quote those numbers; do not recount by hand.

5. Report summary to user:
   - passed count / failed count / skipped count
   - VERIFICATION.md status
   - If `passed`: "Verified — ready to ship. Run `commit` skill to push."
   - If `failed`: list failing TC ids + expected vs actual from the runner output.

> Smoke protects against broken env (auth, DB connection, basic endpoints) before running the full suite. Skip it with `--regression-only` only when you know the env is healthy.

> **`/sf:checklist`** generates the scaffold; **`/sf:manual-test`** runs it. They are separate commands — generating never overwrites a filled checklist (use `--force` on `/sf:checklist` to regenerate from SD, which destroys filled assertions).
