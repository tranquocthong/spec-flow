"""checklist_lib — the CHECKLIST.yaml test runner, split into focused modules.

Entry point is `checklist_lib.runner.main()`; the sibling `_checklist_runner.py`
shim wires it up so `run-checklist.sh` keeps calling the same path.

Modules:
  vars       — ${VAR} expansion + per-run/per-test correlation ids + capture store
  jsonpath   — JSONPath-lite resolver + `json_path:` expression evaluator (zero-dep)
  grammar    — the known setup-step / verify-item kinds (unknown = error, never a no-op)
  auth       — lazy token resolution (keycloak_ropc | client_credentials | payload | bearer
               | cookie | http login token with scope run/suite/test)
  http       — curl-based request execution
  sql        — db-query.sh wrapper, scalar verify assertions, poll-until
  kafka      — produce via produce-event.sh + best-effort lag/dlt/topic checks
  assertions — expect grammar: status, body_contains, json_path, content_*/root_*, field
  setup      — setup-step executor: sql | seed-ref | http+capture | redis | exec | kafka | vars
  proc       — subprocess with a hard timeout (process-group kill) + opt-in retry
  preflight  — list ${VARS} the selected tests need that nothing provides
  results    — run/last-result.json: merged results for --rerun-failed / verify-collect
  runner     — orchestration + main()
"""
