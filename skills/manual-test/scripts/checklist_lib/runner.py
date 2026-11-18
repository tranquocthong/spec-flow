"""Orchestrator — drives every test in a CHECKLIST.yaml.

Per test: per-test setup → request (http | kafka) → expect (status/body/json_path
/poll) → verify (sql scalar + kafka best-effort) → teardown. Global `cleanup.all`
runs after all suites complete. Refuses to bypass: the only way to add a test is
to add a YAML block.
"""
import argparse
import json
import os
import sys

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML required. Install: pip3 install pyyaml", file=sys.stderr)
    sys.exit(2)

from . import assertions, auth, grammar, http, kafka, preflight, proc, results, setup, sql
from .vars import VarStore

GREEN, RED, YELLOW, RESET, BOLD = "\033[32m", "\033[31m", "\033[33m", "\033[0m", "\033[1m"

# `token:` values that mean "send no auth header at all" (unauthenticated request).
# YAML `token:` / `token: ~` already parse to None; these are the spellings a human
# writes when they mean the same thing.
_NO_TOKEN = {"none", "null", "no-auth", "noauth", "anonymous", "false", "-"}


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--checklist", required=True)
    p.add_argument("--scripts-dir", required=True)
    p.add_argument("--tag", default=None)
    p.add_argument("--id", dest="test_id", default=None)
    p.add_argument("--base-url", default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--rerun-failed", action="store_true",
                   help="run only the tests whose last recorded result (run/last-result.json) is FAIL")
    p.add_argument("--results-file", default=None,
                   help="where to keep the merged last result (default: <checklist dir>/run/last-result.json)")
    p.add_argument("--no-preflight", action="store_true",
                   help="skip the missing-variable check before the run")
    p.add_argument("--json", action="store_true",
                   help="emit a final machine-readable JSON line "
                        '{"passed":[...],"failed":[{"id","reason"}]} for verify-collect')
    return p.parse_args(argv)


def _resolve_base(spec, ctx):
    """Pick the base URL for a request/setup step. `base_url_ref: <name>` selects a
    named alternate from config.base_urls (multi-service); default is config.base_url.
    Returns (url, error) — error set only when a ref is given but undefined."""
    ref = spec.get("base_url_ref")
    if not ref:
        return ctx["base_url"], None
    url = (ctx.get("base_urls") or {}).get(ref)
    if not url:
        return None, f"unknown base_url_ref '{ref}' — define it under config.base_urls"
    return url, None


def _db_spec(val, vs, default_db):
    """Normalize one config.databases entry. String → just the database name (same
    server). Mapping → per-field connection spec, `database:` defaulting to config.db
    so an entry can override only the port/host."""
    if isinstance(val, dict):
        spec = {k: vs.expand(str(v)) for k, v in val.items() if v is not None}
        spec.setdefault("database", default_db)
        return spec
    return vs.expand(str(val))


def _send_request(req, ctx):
    """Execute the request. Returns (kind, status, body, raw) or kafka (ok, msg)."""
    vs = ctx["varstore"]
    if req.get("kafka"):
        ok, msg = kafka.produce(req["kafka"], ctx["scripts_dir"], vs)
        return ("kafka", ok, msg, None)

    method = (req.get("method") or "GET").upper()
    path = vs.expand(req.get("path", ""))
    base, berr = _resolve_base(req, ctx)
    if berr:
        return ("error", None, berr, None)
    headers = {}
    tname = req.get("token")
    # `token: none` (and friends) means "send NO auth header" — the natural way to
    # write an unauthenticated / 401 test. Treated literally it looked up a token
    # named "none", missed, and failed the test with `unknown token 'none'` instead
    # of actually issuing the anonymous request. A real token declared under that
    # name still wins, so this stays backward-compatible.
    if tname and str(tname).strip().lower() in _NO_TOKEN and tname not in ctx["tokens"]:
        tname = None
    if tname:
        try:
            k, v = auth.header_for(tname, ctx)
        except Exception as e:
            return ("error", None, str(e), None)
        headers[k] = v
    # Explicit per-test headers (var-expanded). Applied after the token so a test
    # that sets a header wins. Without this, signed requests (X-Client-Id /
    # X-Timestamp / X-Signature) silently lose every custom header.
    for hk, hv in (req.get("headers") or {}).items():
        headers[hk] = vs.expand(str(hv))
    body = vs.expand_obj(req.get("body"))
    url = http.build_url(base, path, vs.expand_obj(req.get("query") or {}))
    status, jbody, raw = http.do_request(method, url, headers, body)
    return ("http", status, jbody, raw)


def _run_verify(verify_block, ctx, errs, msgs, evidence=None):
    """Run every verify item in order. An item of no known kind is a FAILURE: it
    used to fall through to the kafka dispatcher, come back "skipped" and leave the
    test green although its check never ran (an `exec:` item, for one)."""
    evidence = evidence if evidence is not None else []
    vs = ctx["varstore"]
    for i, vb in enumerate(verify_block):
        kind = grammar.verify_kind(vb)
        if kind is None:
            errs.append(f"verify[{i}]: {grammar.describe_unknown(vb, grammar.VERIFY_KINDS)}")
            continue
        if kind == "sql":
            _, verrs, vmsgs = sql.verify_sql([vb], ctx["db"], ctx["scripts_dir"], vs, ctx.get("dbs"))
            errs.extend(verrs)
            msgs.extend(vmsgs)
            exp = vb.get("expect")
            if not verrs and exp is not None and not isinstance(exp, dict):
                evidence.append("verify sql")
        elif kind == "exec":
            try:
                out = setup.run_exec(vb, ctx, label="verify exec")
            except Exception as e:
                errs.append(str(e))
                continue
            ok, detail = sql.check_scalar(out, vb.get("expect"), vs)
            if ok is False:
                errs.append(f"verify exec: {detail}")
                continue
            evidence.append("verify exec")
            msgs.append(f"      verify OK: exec{(' ' + detail) if detail else ' exit 0'}")
        else:
            status, detail = kafka.check(vb, vs)
            if status is None:
                msgs.append(f"      {YELLOW}skip:{RESET} {detail}")
            elif status:
                evidence.append(f"verify {kind}")
                msgs.append(f"      verify OK: {detail}")
            else:
                errs.append(f"kafka verify: {detail}")


# Keys inside `expect` that assert_expect (or the runner's own poll branch) turns
# into an error when they do not hold. Anything else in `expect` is inert — a
# decorative `{n: 3}` produces no error and therefore cannot fail a test.
_ASSERTING_EXPECT_KEYS = {"status", "body_contains", "body_not_contains",
                          "json_path", "body", "poll"}
# Setup steps that actually run something. run_steps aborts on the first failure
# and the caller turns that into a FAIL, so `setup: - exec: ... exit 1` IS a real
# assertion even though the test declares no `expect` at all.
_EXECUTING_SETUP_KEYS = grammar.EXECUTING_STEP_KINDS


def _unexecutable_reason(test):
    """Why this test can produce no evidence, or None if it can.

    PASS is computed as "no assertion reported an error", so a test with nothing
    to send and nothing to assert passes without executing anything: no request
    leaves the machine, `status=0` is printed, and the id lands in the JSON
    "passed" list. Such a test is a placeholder for a hand-run step, and counting
    it as passed is how a feature reaches `status: passed` with no evidence.
    """
    if test.get("request"):
        return None
    if test.get("verify"):
        return None
    exp = test.get("expect")
    if isinstance(exp, dict) and (set(exp) & _ASSERTING_EXPECT_KEYS):
        return None
    for step in test.get("setup") or []:
        if isinstance(step, dict) and (set(step) & _EXECUTING_SETUP_KEYS):
            return None
    tags = [t for t in (test.get("tags") or []) if t in ("no-verify", "live-e2e")]
    hint = f" ({', '.join(tags)})" if tags else ""
    return f"no request, no assertion, no executing setup step{hint} — run it by hand"


def _db_config(cfg, vs):
    """config.db → the default database: a plain name when only `database:` is set
    (db-creds.sh discovers the rest, as before), else a connection spec.

    host/port/user/password used to be IGNORED here — only `database:` was read —
    so a checklist that declared `port: 7110` and `username: app_user` still hit
    whatever db-creds.sh discovered, and the user had to export DB_USER by hand.
    `username:` is accepted as an alias of `user:`."""
    raw = cfg.get("db") or {}
    name = vs.expand(str(raw.get("database", "${DB_NAME:-postgres}")))
    spec = {"database": name}
    for key, alias in (("host", None), ("port", None), ("user", "username"), ("password", None)):
        val = raw.get(key, raw.get(alias) if alias else None)
        if val is not None and str(val) != "":
            spec[key] = vs.expand(str(val))
    return name, (spec if len(spec) > 1 else name)


def _inherit(spec, default_db):
    """A config.databases entry lives on the default server unless it says otherwise."""
    if not isinstance(default_db, dict):
        return spec
    base = {k: v for k, v in default_db.items() if k != "database"}
    if isinstance(spec, dict):
        return {**base, **spec}
    return {**base, "database": spec}


def _status_line(entry):
    return {"passed": f"{GREEN}✓ PASS{RESET}", "failed": f"{RED}✗ FAIL{RESET}",
            "not_verified": f"{YELLOW}— NOT VERIFIED{RESET}"}[entry["status"]]


def main(argv=None):
    args = parse_args(argv)
    try:
        with open(args.checklist) as f:
            doc = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        print(f"{RED}invalid YAML in {args.checklist}: {e}{RESET}")
        print(f"{YELLOW}hint: quote ${{VAR}} inside flow mappings, or use block style "
              f"(db:\\n  database: \"${{DB_NAME}}\").{RESET}")
        return 2

    vs = VarStore()
    cfg = doc.get("config", {}) or {}
    # config.vars: checklist-declared variables — resolve BEFORE os.environ (see
    # references/checklist.md "Variable Resolution"). Values are expanded on load,
    # so `FOO: ${FOO:-default}` keeps an env override possible, and later vars may
    # reference earlier ones. Loaded first so base_url/db below can use them.
    for k, v in (cfg.get("vars") or {}).items():
        vs.set(k, vs.expand(str(v)))
    base_url = args.base_url or vs.expand(cfg.get("base_url", "http://localhost:8081"))
    db_name, db_default = _db_config(cfg, vs)
    # Multi-service: named alternate base URLs (e.g. {auth_base_url: ...}). A test or
    # setup step picks one with `base_url_ref: <name>`; default stays `base_url`.
    base_urls = {k: vs.expand(str(v)) for k, v in (cfg.get("base_urls") or {}).items()}
    # Multi-service, DB side: named alternate databases, symmetric with base_urls. A
    # value is either a plain database NAME (same server as config.db) or a mapping
    # with any of database/host/port/user/password; unset fields fall back to
    # config.db, then to db-creds.sh.
    dbs = {k: _inherit(_db_spec(v, vs, db_name), db_default)
           for k, v in (cfg.get("databases") or {}).items()}

    try:
        default_timeout = proc.default_timeout(cfg)
    except ValueError as e:
        print(f"{RED}config.step_timeout: {e}{RESET}")
        return 2
    sql.TIMEOUT = default_timeout

    # Tokens are resolved lazily (auth.header_for), only when a test uses them.
    ctx = {"db": db_default, "dbs": dbs, "scripts_dir": args.scripts_dir, "base_url": base_url,
           "base_urls": base_urls, "varstore": vs, "tokens": dict(doc.get("tokens") or {}),
           "doc": doc, "default_timeout": default_timeout}

    results_path = args.results_file or results.path_for(args.checklist)
    rerun_ids = None
    if args.rerun_failed:
        prev = results.load(results_path)
        if prev is None:
            print(f"{RED}--rerun-failed: no previous result at {results_path} — run the checklist once first{RESET}")
            return 2
        rerun_ids = set(results.failed_ids(prev))

    print(f"checklist: {args.checklist}")
    print(f"base_url:  {base_url}")
    print(f"db:        {sql.db_label(db_default)}")
    for name, spec in dbs.items():
        print(f"db[{name}]: {sql.db_label(spec)}")
    print(f"corr-id:   {vs.get('TEST_CORRELATION_ID')}")
    if args.tag:
        print(f"filter:    tag={args.tag}")
    if args.test_id:
        print(f"filter:    id={args.test_id}")
    if rerun_ids is not None:
        print(f"filter:    rerun-failed ({len(rerun_ids)} failed last run)")
    print()

    def selected(test):
        tags = test.get("tags", []) or []
        if args.tag and args.tag not in tags:
            return False
        if args.test_id and args.test_id != test.get("id"):
            return False
        if rerun_ids is not None and test.get("id") not in rerun_ids:
            return False
        return True

    suites = doc.get("suites", []) or []
    plan = [(su, [t for t in (su.get("tests") or []) if selected(t)]) for su in suites]
    if rerun_ids is not None and not rerun_ids:
        print(f"{GREEN}nothing to rerun — the last run had no failed test{RESET}")
        return 0

    if not args.no_preflight:
        used_tokens = sorted({n for _, ts in plan for t in ts for n in auth.tokens_used_by(t)})
        miss = preflight.missing(doc, [(su, ts) for su, ts in plan if ts], used_tokens, vs)
        if miss:
            print(f"{RED}preflight: {len(miss)} variable(s) the selected tests need are not set:{RESET}")
            for name, where in miss:
                print(f"  - {name}  (first used at {where})")
            print(f"{YELLOW}export them, put them in {os.path.join(os.path.dirname(results_path), 'env.sh')} "
                  f"(sourced automatically), declare them under config.vars, or rerun with --no-preflight.{RESET}")
            if not args.dry_run:  # a dry run only prints the plan: warn, do not stop
                return 2
            print()

    total = skipped = 0
    entries = {}            # id -> result entry (see results.py)
    teardown_warnings = []  # [{"id", "warning"}] — a failed teardown step never fails the
                            # test itself (by design: recovery ran AFTER the result was
                            # already recorded), but it must not vanish either — it's
                            # surfaced separately so it can't be mistaken for the next
                            # test's own unrelated failure.

    def record(suite, test, status, reason=None):
        e = {"id": test.get("id", "?"), "suite": suite.get("id"), "suiteName": suite.get("name"),
             "status": status, "evidence": test.get("evidence"), "at": results.now()}
        if reason:
            e["reason"] = reason
        entries[e["id"]] = e
        return e

    for suite, tests in plan:
        skipped += len(suite.get("tests") or []) - len(tests)
        if not tests:
            continue  # nothing selected: do not run this suite's setup at all
        print(f"{BOLD}── suite: {suite.get('id', '?')} ──{RESET}")
        auth.begin_scope(ctx, "suite", suite.get("id"))

        if not args.dry_run:
            err = setup.run_steps(suite.get("setup", []), ctx)
            if err:
                print(f"  {RED}suite setup failed: {err}{RESET}")
                for test in tests:
                    total += 1
                    record(suite, test, "failed", f"suite setup failed: {err}")
                continue

        for test in tests:
            tid = test.get("id", "?")
            total += 1
            vs.new_test_start()
            auth.begin_scope(ctx, "test", f"{suite.get('id')}/{tid}/{vs.get('TEST_START')}")

            nv_reason = _unexecutable_reason(test)
            if nv_reason:
                print(f"  {tid}  {YELLOW}— NOT VERIFIED{RESET}: {nv_reason}")
                record(suite, test, "not_verified", nv_reason)
                continue

            req = test.get("request") or {}
            exp = test.get("expect") or {}
            # No `request` block: the assertion lives in setup/verify/poll. Do NOT
            # synthesise a GET here — it used to send an empty request to base_url
            # and print `GET  / status=0`, which reads as a real HTTP check that
            # passed. Against a live environment that stray call can also touch a
            # real endpoint.
            if req:
                label = "kafka" if req.get("kafka") else f"{(req.get('method') or 'GET').upper()} {vs.expand(req.get('path', ''))}"
            else:
                label = "— asserted by setup/verify"
            print(f"  {tid}  {label}")

            if args.dry_run:
                print("    → DRY_RUN (request/SQL skipped)")
                continue

            try:
                ctx["test_timeout"] = proc.parse_duration(test.get("timeout"))
            except ValueError as e:
                print(f"    {RED}✗ FAIL{RESET}\n      timeout: {e}")
                record(suite, test, "failed", f"timeout: {e}")
                continue
            evidence = []
            ctx["evidence"] = evidence

            # Mint the network tokens this test uses before its setup runs, so a
            # `scope: test` token's captured vars (e.g. the new account id) are
            # available to every step of the test, not only after first use.
            terr = None
            for name in auth.tokens_used_by(test):
                if str(name).strip().lower() in _NO_TOKEN and name not in ctx["tokens"]:
                    continue
                try:
                    auth.header_for(name, ctx)
                except Exception as e:
                    terr = str(e)
                    break
            err = terr or setup.run_steps(test.get("setup", []), ctx)
            if err:
                print(f"  {RED}✗ {tid}: setup failed: {err}{RESET}")
                record(suite, test, "failed", f"setup failed: {err}")
                ctx["evidence"] = None
                _teardown(test, ctx, tid, teardown_warnings)
                continue

            kind, a, b, c = (("none", None, None, None) if not req
                             else _send_request(req, ctx))
            errs, msgs = [], []

            if kind == "none":
                # Nothing was sent; only an async settle can still be asserted here.
                if exp.get("poll"):
                    _poll(exp["poll"], ctx, errs, msgs, evidence)
            elif kind == "error":
                errs.append(b)
            elif kind == "kafka":
                if not a:
                    errs.append(f"kafka produce: {b}")
                else:
                    msgs.append(f"      {b}")
                    if exp.get("poll"):
                        _poll(exp["poll"], ctx, errs, msgs, evidence)
            else:  # http
                status, body, raw = a, b, c
                if exp.get("poll"):
                    _poll(exp["poll"], ctx, errs, msgs, evidence)
                a_errs = assertions.assert_expect(exp, status, body, raw, vs)
                if a_errs and body is None and (exp.get("json_path") or exp.get("body")):
                    a_errs.append(f"raw body: {(raw or '')[:200]}")
                errs.extend(a_errs)
                if set(exp) & (_ASSERTING_EXPECT_KEYS - {"poll"}):
                    evidence.append("response")

            verify_block = test.get("verify") or []
            if verify_block:
                _run_verify(verify_block, ctx, errs, msgs, evidence)
            ctx["evidence"] = None

            if errs:
                print(f"    {RED}✗ FAIL{RESET}")
                for e in errs:
                    print(f"      {e}")
                record(suite, test, "failed", "; ".join(str(e) for e in errs) or "FAIL")
            elif not evidence:
                # Ran, raised nothing — and asserted nothing either: every check was
                # skipped (kafka tooling absent), descriptive, or inert. PASS here is
                # how a feature reaches `passed` with no evidence behind it.
                why = "ran, but no check asserted anything (every check skipped or descriptive)"
                print(f"    {YELLOW}— NOT VERIFIED{RESET}: {why}")
                for m in msgs:
                    print(m)
                record(suite, test, "not_verified", why)
            else:
                tail = f"  status={a}" if kind == "http" else ""
                print(f"    {GREEN}✓ PASS{RESET}{tail}")
                for m in msgs:
                    print(m)
                record(suite, test, "passed")

            _teardown(test, ctx, tid, teardown_warnings)

    # Global cleanup (after all suites). `cleanup.db_ref` targets one alternate
    # database; a multi-service run that seeds rows in both needs a `teardown:` step
    # per database instead — cleanup.all is a single statement by design.
    cleanup_cfg = doc.get("cleanup") or {}
    cleanup_all = cleanup_cfg.get("all")
    if cleanup_all and not args.dry_run:
        try:
            sql.run_sql(vs.expand(cleanup_all),
                        sql.resolve_db(cleanup_cfg, db_default, dbs), args.scripts_dir)
            print(f"\n{BOLD}cleanup:{RESET} ran global cleanup")
        except Exception as e:
            print(f"\n{YELLOW}cleanup warning: {e}{RESET}")

    run_tests = list(entries.values())
    passed = [e for e in run_tests if e["status"] == "passed"]
    failed = [e for e in run_tests if e["status"] == "failed"]
    not_verified = [e for e in run_tests if e["status"] == "not_verified"]

    print(f"\n{BOLD}── summary ──{RESET}")
    print(f"  total:   {total}")
    print(f"  {GREEN}passed:  {len(passed)}{RESET}")
    print(f"  {RED}failed:  {len(failed)}{RESET}")
    print(f"  skipped: {skipped}")
    if not_verified:
        print(f"  {YELLOW}not verified: {len(not_verified)}{RESET} (nothing asserted — NOT counted as passed; record evidence by hand)")
        for nv in not_verified:
            print(f"    {YELLOW}- {nv['id']}: {nv['reason']}{RESET}")
    if failed:
        print(f"  {RED}failed tests:{RESET} {' '.join(e['id'] for e in failed)}  (rerun only these: --rerun-failed)")
    if teardown_warnings:
        print(f"  {YELLOW}teardown warnings: {len(teardown_warnings)}{RESET} (recovery/cleanup step failed after the test's own result was recorded — state may be dirty for later tests)")
        for tw in teardown_warnings:
            print(f"    {YELLOW}- {tw['id']}: {tw['warning']}{RESET}")

    if not args.dry_run and entries:
        filtered = bool(args.tag or args.test_id or rerun_ids is not None)
        order = [t.get("id") for su in suites for t in (su.get("tests") or [])]
        prev = results.load(results_path) if filtered else None
        merged = results.merge(prev, entries, order, filtered)
        try:
            results.write(results_path, results.payload(merged, teardown_warnings))
            print(f"  results: {results_path}" + (" (merged with the previous run)" if filtered else ""))
        except OSError as e:
            print(f"  {YELLOW}results not saved ({e}) — --rerun-failed will not see this run{RESET}")

    if args.json:
        # Final machine-readable line for `flow-tools verify-collect`. The human
        # summary above stays for the console; verify-collect reads this last line.
        # It covers THIS run only; run/last-result.json holds the merged view.
        print(json.dumps(results.payload(run_tests, teardown_warnings), ensure_ascii=False))
    return 0 if not failed else 1


def _poll(poll_def, ctx, errs, msgs, evidence):
    ok, detail = sql.poll(poll_def, ctx["db"], ctx["scripts_dir"], ctx["varstore"], ctx.get("dbs"))
    if ok:
        msgs.append(f"      poll: {detail}")
        evidence.append("poll")
    else:
        errs.append(f"poll: {detail}")


def _teardown(test, ctx, tid, sink):
    tw = setup.run_steps(test.get("teardown", []), ctx, warn_only=True)
    for w in tw or []:
        sink.append({"id": tid, "warning": w})
