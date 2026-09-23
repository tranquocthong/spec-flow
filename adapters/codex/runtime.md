## Codex runtime contract

This is the Codex build of SF. The procedures below are generated from the shared
Claude source; these runtime mappings apply to all of them.

- Resolve `SPEC_FLOW_ROOT` to the absolute plugin directory, two parents above this
  SKILL.md's directory. Set it in **each shell call** that uses it; shell variables
  do not persist between calls. Keep the working directory at the target project
  (or its configured hub for task/trace operations). Quote paths. Do not run the
  engine from the plugin directory.
- Read the project's applicable instructions, `CLAUDE.md` when not already loaded,
  `.spec-flow/config.json`, `.spec-flow/project-author.md`, and the active feature's
  state/checkpoint before resuming. Retain `.spec-flow/`, `.taskmaster/`, and legacy
  `.claude/docs/manual-tests/` paths and formats. Do not reinitialize or migrate an
  existing project just because its host changed. Use per-feature state/trace when
  available; root files are mirrors. Serialize shared state/trace writes.
- `$sf-*` names are skill entry points, not shell commands. `<user arguments>` is
  a placeholder for the user's actual arguments, not shell syntax. Commands are
  in `references/commands/`; agent roles are in `references/agents/` under the
  plugin root. Read only the procedure/role needed for the current operation.
- A procedure's `Agent`/`Task` delegation means the available Codex subagent tool:
  pass the relevant role document and task context. When unavailable, perform the
  role in the current agent. Respect session delegation constraints. Claude model
  names such as sonnet/opus and `models.hybridExecutor`/`models.sdAuthor` are not
  Codex model identifiers: inherit the Codex model unless the user supplies a
  supported Codex override. Role frontmatter is reference data, not tool config.
- Run engine operations through `scripts/flow-tools.cjs` and
  `scripts/task-master.cjs`. The wrappers declare a host with
  `SPEC_FLOW_HOST_AGENT=1`. In `agent-native` mode, a GenerationSpec is a request
  for YOU to generate schema-valid content, then call `tasks-import`; emitting a
  spec alone does not complete task generation. Existing explicit provider modes
  remain intact; report incompatibilities rather than changing project config.
- `$sf-init` uses the shared init procedure with Codex provider setup. The engine
  defaults to `agent-native`; Codex is the host. Keep existing model settings
  untouched. Missing Claude CLI is not a prerequisite failure for this mode.
- The optional pre-ship review step names a host `code-review` skill. That skill is
  a Claude Code built-in and is NOT part of this package. When Codex has no
  equivalent, perform the review yourself against the step's own output contract
  (severity/title/file/line/category/detail) — read-only, report only, never fix.
  Keep the gate's shape either way: `review-scope` decides whether to run and asks
  the user when it returns `gate: ask`, and `review-collect` is what makes the
  result real. A review you performed but did not collect did not happen.
- Bare `scripts/*.sh` in a procedure refers to the bundled testing helpers at
  `${SPEC_FLOW_ROOT}/skills/sf-testing/scripts/`, not a target project's scripts.
  Read `$sf-testing` for stack/auth/checklist details. `$sf-manual-test` runs the
  SF feature checklist; `$sf-commit` is the SF shipping skill.
- Preserve real SD/task review gates and existing user approvals. Use the available
  question tool or chat for missing decisions. Workflow text does not authorize
  an unrelated push, publish, tag, or message. Follow the user's requested scope.
- Hooks require trust in Codex. Whether hooks are enabled or not, explicitly record
  verification through `verify-collect`, update state after completed tasks, and
  checkpoint before a voluntary handoff. Do not equate prose or exit 0 with a
  persisted passing result. Hooks are supplemental, not the verification gate.
