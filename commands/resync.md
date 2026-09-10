---
description: "Product changed the SRS (top-down): diff vs snapshot, propagate a delta to SD + tasks + checklist via the traceability matrix, re-open impacted tasks. No full regen. Bottom-up counterpart is /sf:change."
argument-hint: <path/to/srs_v2.md>
allowed-tools: Read, Write, Edit, Bash, Agent
---

# /sf:resync — propagate an SRS change (surgical, not regen)

> **Re-anchor:** read `.spec-flow/STATE.md` (its **Next Step**) before acting; run `state-update` after each step so the flow survives long sessions.

Input: `$ARGUMENTS` (new SRS file path). Change only what changed — the traceability matrix identifies exactly which SD sections, tasks, checklist tests, and files an SRS edit touches.

## Preconditions
- `.spec-flow/snapshots/` has at least one baseline (created by `/sf:ingest`).
- `.spec-flow/trace.json` exists (run `trace-build` if missing).

## Steps

1. **Diff SRS versions**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-diff --new <srs_v2.md>
   ```
   Auto-resolves the latest snapshot (or `--old <snapshot.md>` for a specific version). Outputs two layers: CHANGESET `{ added, changed, removed }` keyed by SRS anchors (US, AC, NFR, BL, state) **plus `data.prose` `{ added, removed }`** — a per-section bullet diff that catches revisions in anchor-free prose SRS (where the anchor layer is blind; `data.anchors {old,new}` tells you how blind). Treat both as hints for sd-author; SD remains the authoritative artifact.

   **Guard — empty changeset (`emptyChangeset: true`):** STOP. `emptyChangeset` is true only when BOTH layers (anchor + prose) saw nothing — so this doc is almost certainly **not a revision** of the tracked SRS. Surface `data.hint` and ask the user: is this a **new/different feature** (→ `/sf:ingest`) or a **spec tweak** (→ `/sf:change`)? Do **not** run steps 2-8 (the whole pipeline would be a silent no-op against the wrong input). Only proceed if the user confirms they genuinely expected an empty delta (e.g. re-running after a partial resync).

   **Anchor-blind case (anchor counts 0/0/0 but `proseCounts` non-zero):** this IS a genuine revision of a prose-form SRS. Continue the pipeline and feed `data.prose` entries (section + text) to sd-author as the changeset.

   > **Do NOT rely on `trace-impact --changeset` alone here.** It seeds from FR-/TC-/ERR_ ids found *inside* the changed text, and prose acceptance criteria carry none — a bullet like "a duplicate submission returns the original result" never names FR-003. Verified: a prose-only changeset resolves to `impacted: {}`. Instead pull the distinctive nouns out of the changed bullets and pass them as keywords:
   > ```
   > node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-impact --feature <feature> --keywords "idempotency,cancel"
   > ```
   > On the same change that `--changeset` missed entirely, `--keywords "idempotency,cancel"` resolved FR-003, TC-003, the error code, the implementing task and its file. Use `--changeset` when the SRS is anchored (ids in the text) and `--keywords` when it is prose; run both and union the results if unsure.

2. **Resolve impact**
   Write the changeset JSON to a temp file, then:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-impact \
     --changeset <changeset.json>
   ```
   Returns `{ impacted: { fr, tc, errors, tasks, files }, reasons }`. `--ids "FR-007,TC-012"` and `--keywords "callback,timeout"` are the direct forms — for a prose-form SRS `--keywords` is the ONLY one that resolves anything (see the anchor-blind note in step 1).

3. **Update SD delta only**
   - Re-run `sd-skeleton --srs <srs_v2.md> --force` (the `--force` is required — sd-skeleton refuses to overwrite an existing SD otherwise; resync deliberately re-derives the impacted deterministic sections: §5.1 FR, §12.2 errors, §13.2 TC rows for impacted IDs).
   - Spawn **sd-author** with: new SRS + current SD + impacted FR/TC IDs from step 2 + `CONTEXT.md` **+ an explicit first line of the spawn prompt: `Author all SD/CONTEXT prose in language: <config.language>`** (read `config.language`, default `en`; skip the directive when `en`). Surfacing it explicitly is what makes the language take effect — don't rely on the sub-agent reading `config.json` on its own. sd-author re-derives only impacted reasoning sections; marks touched sections `TODO:MANUAL-REVIEW`. **Model:** read `config.json → models.sdAuthor`; if set to a non-null value, pass it as the Agent tool's `model` param. If absent/`null` (the default), omit the param — sd-author inherits the main session's model.

4. **Gate — wait for review**
   Report SD delta diff + remaining `TODO:MANUAL-REVIEW` count — count with `grep -cE '\*\*TODO:MANUAL-REVIEW\*\*'` (the bold marker form, including one embedded mid-line in a table cell or list item), never a bare string grep (that also matches the preamble banner, the Pass-2 summary line, and revision-history prose — none of which bold the phrase). **Refuse to cascade tasks while any TODO marker remains.**

5. **Cascade tasks** (AI op — cascades the changeset summary onto downstream tasks)
   Both flags are required; `--from=<id>` does NOT work (the parser wants a space) and without `--tag` it resolves tag `undefined`.
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/task-master update --from <lowest impacted task id> \
     --tag <feature> --prompt "<changeset summary>"
   ```

6. **Re-align ALL impacted tasks to the new spec — not just `done` ones.**
   For each task ID in `impacted.tasks`, by current status:
   - **`done`** → `task-set-status --status review` (re-verify against the new SD).
   - **`in-progress`** → **STOP and warn**: this task is being implemented RIGHT NOW against the OLD spec. Surface it to the user, set it back to `pending`, and make sure its executor re-reads the updated SD section before continuing — otherwise it ships stale behavior silently. This is the W2 hole: an in-flight task is the most dangerous to leave un-flagged.
   - **`pending`** → leave `pending` (it hasn't been built yet, so it will pick up the new SD naturally), but **list it** in the resync report so the user sees the full blast radius.
   ```bash
   E=${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs
   node $E task-set-status --tag <feature> --id <id> --status review    # each impacted `done` task
   node $E task-set-status --tag <feature> --id <id> --status pending   # each impacted `in-progress` task (+ warn the user)
   node $E task-add --tag <feature> --title "<t>"                       # net-new FR with no existing task
   ```
   Deterministic state ops on `.taskmaster/tasks/tasks.json` — no model, no MCP.
   Report the impacted set grouped by prior status so nothing implemented-against-old-spec slips through.

7. **Regenerate impacted checklist entries**
   Run `/sf:checklist` for the feature, preserving filled verify SQL for unaffected TCs. Re-scaffold only rows whose TC IDs appear in `impacted.tc`.

8. **New snapshot + rebuild trace**
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs srs-snapshot --srs <srs_v2.md>
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs trace-build --sd .spec-flow/specs/<feature>/SD.md --feature <feature>
   node ${CLAUDE_PLUGIN_ROOT}/bin/flow-tools.cjs state-update --feature <feature> \
     --note "srs-resync: <summary of changeset>"
   ```

Run `/sf:phase <feature>` to re-implement the `review` tasks → manual-test → `done`.

## Pipeline recap
```
srs-diff → trace-impact → SD delta via sd-author → CLI `node ${CLAUDE_PLUGIN_ROOT}/bin/task-master update --from` cascade
  → re-open impacted done tasks → regenerate impacted checklist
  → srs-snapshot (new baseline) → trace-build → state-update
```
