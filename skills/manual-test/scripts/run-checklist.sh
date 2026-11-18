#!/usr/bin/env bash
# run-checklist.sh — drive every test from CHECKLIST.yaml (enforces Hard Rule #6)
#
# This is THE entry point for test execution. Ad-hoc curl is not allowed; if you
# find yourself wanting to bypass this runner, add a test to the checklist instead.
#
# Implementation lives in the checklist_lib/ package (one module per concern);
# _checklist_runner.py is a thin shim. See that package for the full grammar.
#
# Workflow:
#   1. Lint checklist (refuses TODO/scaffold markers; requires an assertion per test)
#   2. Resolve tokens (keycloak_ropc | client_credentials | `payload` X-Userinfo)
#   3. Per suite: run suite `setup` (sql | seed | http+capture | redis)
#   0. Source <checklist dir>/run/env.sh if it exists (tokens, DB_USER, ids — never
#      committed: run/ is git-ignored); preflight lists every ${VAR} the selected
#      tests need that nothing sets, and stops before anything runs
#   1b. Tokens resolve lazily, on first use (a login `http:` token, scope run|suite|test)
#   4. Per test: setup → request (http | kafka) → expect → verify → teardown
#      Every exec/SQL step has a timeout (default 5m; `timeout:` per step/test,
#      config.step_timeout, env CHECKLIST_STEP_TIMEOUT) — a hang FAILS as hung
#   5. Global `cleanup.all` after all suites; summary with PASS/FAIL/NOT VERIFIED;
#      merged result kept in <checklist dir>/run/last-result.json
#
# PASS needs evidence: a test that raised no error but asserted nothing at runtime
# (every check skipped or descriptive) is NOT VERIFIED, never PASS. An unknown
# setup/teardown step or verify item is an error, not a silent no-op.
#
# `expect` assertions:
#   status: N                     → exact HTTP status
#   body_contains: "x" | [..]     → substring(s) present in raw response body
#   body_not_contains: "x" | [..] → substring(s) absent
#   json_path: "$.a == \"x\"" | [..] → JSONPath-lite expr(s): == != > < >= <= contains exists
#   poll: { sql, until, ... }     → async: poll a query until it equals `until`
#   body:                         → object/array matchers:
#     <field>: <value>            exact match on a top-level field
#     content_length / content: [] / content_all_match: {} / content_contains: [{}]   (Page envelope)
#     root_length / root_all_match: {} / root_contains: [{}]                            (bare JSON array)
#
# `verify` items:
#   - sql: "..."  expect: <scalar|op>   → HARD assert vs the scalar result (dict expect = descriptive)
#   - exec: "cmd" [expect: <scalar|op>] → exit 0 required; optional assert on stdout
#                                          (timeout:, retry:, retry_on: as for setup exec)
#   - kafka_consumer_lag / kafka_dlt / kafka_topic   → best-effort (SKIP if kcat/docker absent)
#
# Per-run ${TEST_CORRELATION_ID} and per-test ${TEST_START} (UTC, Postgres now() format)
# are auto-injected. Extend the grammar in checklist_lib/, not by inventing new YAML shapes.
#
# Usage:
#   run-checklist.sh <feature> [--tag smoke|regression|...] [--id TEST-ID] [--json]
#                              [--rerun-failed] [--no-preflight] [--env FILE]
#   run-checklist.sh <path/to/CHECKLIST.yaml> [--tag smoke]
#   --json          → also print a final {"passed":[...],"failed":[{id,reason}],"tests":[...]}
#                     line (for `flow-tools verify-collect`; the summary still prints above it)
#   --rerun-failed  → run only the tests that FAILED in run/last-result.json; the result
#                     is merged back, so the file keeps covering the whole checklist
#   --env FILE      → source FILE instead of <checklist dir>/run/env.sh
#
# Env:
#   BASE_URL   override base_url (default from checklist.config.base_url)
#   DRY_RUN=1  print plan, don't execute requests/SQL
#   CHECKLIST_STEP_TIMEOUT  default per-step timeout (seconds or "5m")
#
# psql: db-query.sh runs `psql` from PATH unless .spec-flow/config.json sets
#   manualTest.psql: "<command prefix>"           e.g. "/opt/pg16/bin/psql"
#   manualTest.psql: {"container": "<name>"}      run psql inside that Docker container
# (env SF_PSQL / SF_PSQL_CONTAINER override the config).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

err() { echo "ERROR: $*" >&2; }

if [[ $# -lt 1 ]]; then
  err "usage: run-checklist.sh <feature|path> [--tag smoke] [--id TEST-ID] [--json] [--rerun-failed] [--no-preflight] [--env FILE]"
  exit 2
fi

ARG="$1"; shift || true
TAG_FILTER=""
ID_FILTER=""
JSON_OUT=""
RERUN_FAILED=""
NO_PREFLIGHT=""
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG_FILTER="$2"; shift 2 ;;
    --id)  ID_FILTER="$2";  shift 2 ;;
    --json) JSON_OUT="1"; shift ;;
    --rerun-failed) RERUN_FAILED="1"; shift ;;
    --no-preflight) NO_PREFLIGHT="1"; shift ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    *) err "unknown arg: $1"; exit 2 ;;
  esac
done

# Resolve checklist path: literal path, spec-flow feature, or standalone feature.
if [[ -f "$ARG" ]]; then
  CHECKLIST="$ARG"
elif [[ -f ".spec-flow/specs/$ARG/CHECKLIST.yaml" ]]; then
  CHECKLIST=".spec-flow/specs/$ARG/CHECKLIST.yaml"   # spec-flow layout (feature name)
elif [[ -f ".claude/docs/manual-tests/features/$ARG/CHECKLIST.yaml" ]]; then
  CHECKLIST=".claude/docs/manual-tests/features/$ARG/CHECKLIST.yaml"   # standalone layout
else
  err "checklist not found: $ARG (tried literal path, .spec-flow/specs/$ARG/, .claude/docs/manual-tests/features/$ARG/)"
  exit 2
fi

# Step 0: environment. run/env.sh next to the checklist holds what a run needs
# (tokens, DB_USER, fixture ids) so nobody re-exports them by hand each time.
# `set -a` exports every assignment, so the python runner and its subprocesses
# see them. An explicit --env FILE must exist; the default one is optional.
if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  err "--env file not found: $ENV_FILE"
  exit 2
fi
ENV_FILE="${ENV_FILE:-$(dirname "$CHECKLIST")/run/env.sh}"
if [[ -f "$ENV_FILE" ]]; then
  # env.sh usually holds tokens: make sure its run/ dir is git-ignored before
  # anything else (never overwrites an existing .gitignore).
  if [[ "$(basename "$(dirname "$ENV_FILE")")" == "run" && ! -e "$(dirname "$ENV_FILE")/.gitignore" ]]; then
    printf '%s\n' "# run artifacts and env.sh (may hold tokens) — never commit" "*" > "$(dirname "$ENV_FILE")/.gitignore"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  echo "env: sourced $ENV_FILE"
fi

# psql command from .spec-flow/config.json (manualTest.psql), unless env already
# sets it. Read with python (already required) so no jq dependency.
if [[ -z "${SF_PSQL:-}" && -z "${SF_PSQL_CONTAINER:-}" && -f .spec-flow/config.json ]]; then
  eval "$(python3 - <<'PY'
import json, shlex
try:
    cfg = json.load(open(".spec-flow/config.json"))
except Exception:
    cfg = {}
v = ((cfg.get("manualTest") or {}).get("psql")) if isinstance(cfg, dict) else None
if isinstance(v, str) and v.strip():
    print("export SF_PSQL=" + shlex.quote(v.strip()))
elif isinstance(v, dict) and v.get("container"):
    print("export SF_PSQL_CONTAINER=" + shlex.quote(str(v["container"])))
PY
)"
fi

# Step 1: lint
echo "── lint ──────────────────────────────────────"
if ! "$SCRIPT_DIR/lint-checklist.sh" "$CHECKLIST"; then
  exit 1
fi

# Step 2+: run via python
echo ""
echo "── run ───────────────────────────────────────"
exec python3 "$SCRIPT_DIR/_checklist_runner.py" \
  --checklist "$CHECKLIST" \
  --scripts-dir "$SCRIPT_DIR" \
  ${TAG_FILTER:+--tag "$TAG_FILTER"} \
  ${ID_FILTER:+--id "$ID_FILTER"} \
  ${BASE_URL:+--base-url "$BASE_URL"} \
  ${DRY_RUN:+--dry-run} \
  ${RERUN_FAILED:+--rerun-failed} \
  ${NO_PREFLIGHT:+--no-preflight} \
  ${JSON_OUT:+--json}
