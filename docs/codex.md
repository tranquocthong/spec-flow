# Spec Flow for Codex

Claude and Codex use the same SF source and the same project artifacts. The Codex
package is generated; do not maintain a second copy of the workflow or edit
`dist/codex/` manually. The build takes its version from
`.claude-plugin/plugin.json` and records the Git commit and source SHA-256 hashes
in `build-info.json`. It never fetches a moving `latest` dependency during a build.

## Build and install locally

Prerequisites: Node >=18, Python 3 + PyYAML for manual testing, and a Codex version
supporting plugins. CLI commands below were checked with Codex CLI 0.154.0.

From the SF repository root:

```sh
node scripts/build-codex.cjs
node scripts/validate-codex.cjs
codex plugin marketplace add ./dist/codex
codex plugin add sf@spec-flow-codex
```

Start a new Codex conversation in the **target project**. Review and trust the
three plugin hooks using `/hooks`; Codex skips hooks until their current
configuration has been trusted. This is a Codex runtime requirement, not an SF
approval gate. Never auto-edit Codex's hook trust records.

Then use `$sf-status` (or select the SF status skill from the skill picker).
For existing projects, do not run init or convert the artifacts just to switch
hosts. Read the current feature's checkpoint and continue from disk.

To update a local build after an upstream release, check out the desired SF
release, rebuild and validate, then use `codex plugin add sf@spec-flow-codex` to
install the rebuilt package. Check `codex plugin list` and start a new conversation
so the new skill catalog is loaded. The installed plugin is cached: rebuilding
the source directory alone does not refresh an installed copy. During adapter
iteration at the same SF version, use Codex's `plugin-creator` update workflow:
validate the local marketplace name, apply its `update_plugin_cachebuster.py`
helper to the generated plugin, then re-add `sf@spec-flow-codex`. This appends a
`+codex.<token>` suffix while preserving the SF base version. Do this only after
build validation; release builds remain reproducible without a local suffix.

## Entry points

| Claude | Codex |
| --- | --- |
| `/sf:init` | `$sf-init` |
| `/sf:ingest` | `$sf-ingest` |
| `/sf:phase` | `$sf-phase` |
| `/sf:status` | `$sf-status` |
| `/sf:checkpoint` | `$sf-checkpoint` |
| `/sf:bug`, `/sf:change`, `/sf:resync` | `$sf-bug`, `$sf-change`, `$sf-resync` |
| `/sf:split`, `/sf:checklist`, `/sf:doctor` | `$sf-split`, `$sf-checklist`, `$sf-doctor` |
| `/sf:manual-test` (feature execution) | `$sf-manual-test` |
| bundled manual-test skill (test authoring/helpers) | `$sf-testing` |
| bundled srs-to-sd skill (intent routing) | `$sf-srs-to-sd` |
| bundled commit skill | `$sf-commit` |

The Codex build includes all 12 command procedures, all 3 skills, both agent role
references, and adaptations for all 3 hooks. Role documents are passed to Codex's
available delegation tools; they are not Claude agent registrations. Claude model
names are not translated into guessed GPT names: the current Codex model is
inherited. Session restrictions and existing user authorization still apply.

## Shared artifacts and project instructions

The adapter preserves `.spec-flow/`, `.taskmaster/`, and legacy
`.claude/docs/manual-tests/` paths. The bundled engine, templates and task schema
are byte-identical to the source. The Codex doctor wrapper checks the testing
harness at its generated `skills/sf-testing/scripts/` location.

Codex wrappers set `SPEC_FLOW_HOST_AGENT=1` only for the process they run. They do
not persist provider or model changes in a project. In the default `agent-native`
mode, Codex fulfills GenerationSpec and calls `tasks-import`. Explicit legacy or
headless provider configurations still need their original dependencies; they
are not silently migrated.

The SF skills read CLAUDE.md when it has not already been loaded. To make Codex
also discover it automatically outside SF invocations, merge this top-level
setting into your existing personal `~/.codex/config.toml` (preserve any current
fallback entries):

```toml
project_doc_fallback_filenames = ["CLAUDE.md"]
```

Codex uses at most one instruction file per directory: `AGENTS.override.md`,
`AGENTS.md`, then fallback names. If a project already has AGENTS.md, add an
explicit reference there when CLAUDE.md contains additional shared instructions.
A file at `.agents/AGENTS.md` is not a root AGENTS.md. Claude chat transcripts and
out-of-repo memory do not automatically become Codex memory; capture important
unrecorded decisions in the project's handoff documents.

Serialize shared task/trace writes across agents. Feature tags isolate task sets,
but root state/trace mirrors are shared and do not provide concurrent-writer
locking. Prefer an explicit feature when switching between active efforts.

## Hooks and verification

- Prompt anchor maps `$sf-*` to the existing SF anchor and returns Codex context.
- Drift detection checks every added/updated/deleted/moved path in `apply_patch`
  against the existing per-feature trace using the shared drift script.
- Regression collection normalizes supported Codex output shapes and calls the
  original `verify-collect` with the feature explicitly extracted from
  `.spec-flow/specs/<feature>/CHECKLIST.yaml`. Missing feature/output does not
  create a passing result. Other features' durable verification is preserved.

Hooks supplement the explicit workflow. Always call `verify-collect` and update
state in the procedure itself, including when hooks are disabled or unavailable.
Shell-based file edits and specialized tool paths are not a complete drift hook
coverage boundary. Codex doctor replaces Claude installation checks with package
checks; it does not claim to inspect registration or hook trust.

## Separate release pipeline

`.github/workflows/codex-release.yml` runs Node tests on Node 18/22, the Python
checklist tests, build and distribution validation. Pull requests, main pushes,
and manual runs produce a `spec-flow-codex` CI artifact. When an SF GitHub release
is published, the pipeline also attaches `spec-flow-codex.tar.gz` to that release,
after checking its tag matches the manifest version. Claude's manifest, workflow
sources and installation route are unchanged.

For a published package, extract the archive into a stable directory, add that
directory with `codex plugin marketplace add /path/to/extracted-package`, then
install `sf@spec-flow-codex`. Keep the directory available for updates. The source
repository's main branch contains build sources, not a prebuilt Codex marketplace;
do not install it directly as one. This pipeline does not publish a public Codex
directory listing or rewrite an existing GitHub release by itself.

Before release, run locally:

```sh
node --test test/*.test.cjs
python3 -m unittest discover -s skills/manual-test/scripts/checklist_lib/tests
node scripts/build-codex.cjs
node scripts/validate-codex.cjs
```

The adapter tests cover original-engine → Codex → original-engine task handoff,
checkpoint/config preservation, keyless GenerationSpec/import, invalid import
atomicity, multi-file drift, per-feature verification, reproducible packaging,
and package doctor checks. They do not constitute a live AI/browser/E2E test in
every consuming project.

Official references: [skills](https://learn.chatgpt.com/docs/build-skills),
[plugins](https://learn.chatgpt.com/docs/build-plugins),
[hooks](https://learn.chatgpt.com/docs/hooks),
[project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
