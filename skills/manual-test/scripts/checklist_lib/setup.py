"""Setup/teardown step executor.

Each step is one of:
  - sql: "..."            run SQL (optional `capture: {VAR: ...}` → first scalar;
                          optional `expect:` → pre-state GUARD, aborts the test on
                          mismatch. Scalar expect asserts; dict expect is descriptive.
                          optional `db_ref:` → another service's database.)
  - seed: name            run the named snippet from the top-level `seed:` map
                          (optional `db_ref:`)
  - http: {...}           call an endpoint (optional `capture: {VAR: "$.json.path"}`;
                          optional `expect_status: 401 | [400, 401] | any` — the status(es)
                          this step is SUPPOSED to get, for setup that deliberately drives
                          failures, e.g. wrong-OTP attempts. Absent → any status >= 400 aborts)
  - redis: |              run redis-cli line(s)
  - exec: "cmd"           run a project command; capture stdout into vars
                          (optional `capture: {VAR: "$.json.path"}` if the command
                          prints JSON, else `{VAR: stdout}` captures the whole output).
                          Generic escape hatch: request signing, token minting, any
                          pre-compute lives in the PROJECT's script — not in this runner.
                          Optional `timeout:` (seconds or "5m"; default 5m, see proc.py) —
                          a command that outlives it is killed and the step FAILS as hung.
                          Optional `retry: N` + `retry_on: <regex>` — re-run a non-zero
                          exit (only when the output matches retry_on, if given).
  - kafka: {...}          produce an event (same shape as a request's `kafka:`)
  - vars: {NAME: value}   set variables inline (values are ${VAR}-expanded)

Any other key is an ERROR, not a no-op (see grammar.py).

`ctx` carries: db, dbs, scripts_dir, base_url, base_urls, varstore, tokens, doc,
and optionally default_timeout / test_timeout (seconds) and evidence (a list the
runner reads to tell "asserted something" from "ran nothing").
"""
import json

from . import auth, grammar, http, jsonpath, proc, sql


def run_steps(steps, ctx, dry_run=False, warn_only=False):
    """Run a list of setup/teardown steps.

    warn_only=False (setup): aborts on the first failure, returns the error string
    (None if every step ok).

    warn_only=True (teardown): best-effort — every step still runs even after one
    fails. Returns the list of warning strings (empty if none), rather than only
    printing them: a teardown step is often RECOVERY (undo a mutation, restore a
    row), and a failed recovery that only prints to console vanishes into scrollback
    — the caller has no way to know it happened, so it can't surface in the run's
    JSON result or VERIFICATION.md, and the corrupted state it leaves behind then
    breaks a LATER, unrelated test with no link back to the real cause.
    """
    warnings = []
    for sb in steps or []:
        try:
            _run_one(sb, ctx, dry_run)
        except Exception as e:
            if warn_only:
                msg = str(e)
                print(f"      teardown warning: {msg}")
                warnings.append(msg)
                continue
            return str(e)
    return warnings if warn_only else None


def _run_one(sb, ctx, dry_run):
    kind = grammar.step_kind(sb)
    if kind is None:
        raise RuntimeError(f"step {grammar.describe_unknown(sb, grammar.STEP_KINDS)}")
    if kind == "vars":
        _do_vars(sb, ctx)
    else:
        _HANDLERS[kind](sb, ctx, dry_run)
    if not dry_run and kind in grammar.EXECUTING_STEP_KINDS and ctx.get("evidence") is not None:
        ctx["evidence"].append(f"setup {kind}")


def _do_sql(sb, ctx, dry_run):
    if dry_run:
        return
    vs = ctx["varstore"]
    target = sql.resolve_db(sb, ctx["db"], ctx.get("dbs"))
    result = sql.run_sql(vs.expand(sb["sql"]), target, ctx["scripts_dir"])
    # SQL capture is scalar: first column of the first row → each named var.
    scalar = result.splitlines()[0].strip() if result else ""
    for var in sb.get("capture") or {}:
        vs.set(var, scalar)
    # `expect:` on a setup sql is a pre-state GUARD, not a comment. A seed that
    # landed in the wrong state must abort the test — otherwise the test runs on
    # an unconfirmed baseline and can PASS for the wrong reason. Scalar expect is
    # a hard assertion; a dict expect stays descriptive (see this module's sql.py).
    ok, detail = sql.check_scalar(scalar, sb.get("expect"), vs)
    if ok is False:
        raise RuntimeError(f"setup sql guard failed — {detail}\n        query: {vs.expand(sb['sql'])}")
    if ok:
        print(f"      setup guard OK: {detail}")


def _do_seed(sb, ctx, dry_run):
    name = sb["seed"]
    snippet = (ctx["doc"].get("seed") or {}).get(name)
    if snippet is None:
        raise RuntimeError(f"seed '{name}' not defined in top-level seed:")
    if not dry_run:
        target = sql.resolve_db(sb, ctx["db"], ctx.get("dbs"))
        sql.run_sql(ctx["varstore"].expand(snippet), target, ctx["scripts_dir"])


# `token:` spellings that mean "no auth header" (mirrors runner._NO_TOKEN).
_NO_TOKEN = {"none", "null", "no-auth", "noauth", "anonymous", "false", "-"}


def http_call(h, ctx, sibling=None):
    """Issue one `http:` spec (setup step, teardown step or an `http:` token) and
    enforce its status rule. Returns (status, json_body_or_None, raw).

    `token:` resolves through auth.header_for, so an unknown name is an error here
    too — it used to be dropped silently, sending the call without auth."""
    sibling = sibling or {}
    vs = ctx["varstore"]
    method = (h.get("method") or "GET").upper()
    path = vs.expand(h.get("path", ""))
    headers = {}
    tname = h.get("token")
    if tname and str(tname).strip().lower() in _NO_TOKEN and tname not in (ctx.get("tokens") or {}):
        tname = None
    if tname:
        k, v = auth.header_for(tname, ctx)
        headers[k] = v
    for hk, hv in (h.get("headers") or {}).items():
        headers[hk] = vs.expand(str(hv))
    body = vs.expand_obj(h.get("body"))
    ref = h.get("base_url_ref")
    base = (ctx.get("base_urls") or {}).get(ref) if ref else ctx["base_url"]
    if ref and not base:
        raise RuntimeError(f"unknown base_url_ref '{ref}' — define it under config.base_urls")
    url = http.build_url(base, path, vs.expand_obj(h.get("query") or {}))
    status, jbody, raw = http.do_request(method, url, headers, body)
    # `expect_status:` (nested in `http:` or sibling of it, like `capture:`; nested
    # wins) declares the status this step is MEANT to get. Absent keeps the legacy
    # rule (>= 400 aborts the setup). Declared means exactly that: a status outside
    # the declared set still aborts, so a step that expects a 401 cannot go green on
    # a 200 or a 500. "any" accepts every real HTTP response, but never status 0
    # (no response at all).
    declared = h.get("expect_status", sibling.get("expect_status"))
    if declared is None:
        if status >= 400:
            raise RuntimeError(f"setup http {method} {path} → {status}")
    else:
        allowed = parse_expect_status(declared)
        if allowed is None:
            raise RuntimeError(f"setup http {method} {path}: invalid expect_status {declared!r} — use an int, a list of ints, or \"any\"")
        if not _status_allowed(status, allowed):
            want = "any HTTP response" if allowed == "any" else "/".join(str(c) for c in sorted(allowed))
            raise RuntimeError(f"setup http {method} {path} → {status} (expect_status: {want})")
    # `capture:` is documented and templated as nested INSIDE the `http:` block
    # (sibling of method/path/token/body — see templates/CHECKLIST.yaml and this
    # module's own docstring), not as a sibling of `http:` at the step level (that
    # convention is `sql`'s and `exec`'s, whose payloads are bare strings with
    # nowhere else to put it). `h` IS `sb["http"]`, so `h.get("capture")` is the
    # canonical place.
    #
    # BOTH forms are accepted, and the sibling one is not a typo to be punished.
    # Reading only `sb.get("capture")` used to be the bug here — but narrowing to
    # only `h.get("capture")` swung it the other way and silently zeroed every
    # capture in checklists written against the old reading: one dogfood project
    # had 33 of them across 7 features, and one feature went from a real 21/21 to 3/22
    # without a line of its own changing. A capture resolving to "" fails several
    # steps later as a 400 or a blank curl argument, which reads like an app bug.
    # Nested wins when a step somehow carries both.
    return status, jbody, raw


def _do_http(sb, ctx, dry_run):
    if dry_run:
        return
    vs, h = ctx["varstore"], sb["http"]
    _, jbody, _ = http_call(h, ctx, sibling=sb)
    for var, expr in (h.get("capture") or sb.get("capture") or {}).items():
        vals = jsonpath.resolve(vs.expand(expr), jbody) if jbody is not None else []
        vs.set(var, vals[0] if vals else "")


def parse_expect_status(value):
    """Normalise an `expect_status:` value to "any" or a set of ints; None if invalid.
    Shared with lint-checklist.sh so the linter and the runner agree on the grammar."""
    if isinstance(value, str) and value.strip().lower() == "any":
        return "any"
    items = value if isinstance(value, list) else [value]
    codes = set()
    for it in items:
        if isinstance(it, bool):
            return None
        if isinstance(it, str) and it.strip().isdigit():
            it = int(it.strip())
        if not isinstance(it, int) or not 100 <= it <= 599:
            return None
        codes.add(it)
    return codes or None


def _status_allowed(status, allowed):
    if allowed == "any":
        return status > 0
    return status in allowed


def step_timeout(step, ctx):
    """Seconds for one exec/sql step: step `timeout:` > test `timeout:` > run default."""
    t = proc.parse_duration(step.get("timeout")) if isinstance(step, dict) else None
    return t or ctx.get("test_timeout") or ctx.get("default_timeout") or float(proc.DEFAULT_TIMEOUT)


def run_exec(sb, ctx, label="exec"):
    """Run an `exec:` command (setup, teardown or verify) under its timeout and retry
    policy. Returns the stripped stdout; raises RuntimeError on non-zero / hang."""
    vs = ctx["varstore"]
    cmd = vs.expand(sb["exec"])

    def note(n, p):
        print(f"      {label} retry {n}/{sb.get('retry')}: exit {p.returncode} — "
              f"{((p.stderr or '') + (p.stdout or '')).strip()[-160:]}")

    p = proc.run_with_retry(cmd, step_timeout(sb, ctx), retry=sb.get("retry") or 0,
                            retry_on=sb.get("retry_on"), on_retry=note)
    if p.returncode != 0:
        detail = ((p.stderr or "").strip() or (p.stdout or "").strip())[-300:]
        raise RuntimeError(f"{label} failed ({p.returncode}): {cmd.strip()[:300]}"
                           + (f"\n{detail}" if detail else ""))
    return (p.stdout or "").strip()


def _do_exec(sb, ctx, dry_run):
    if dry_run:
        return
    vs = ctx["varstore"]
    out = run_exec(sb, ctx, label="setup exec")
    cap = sb.get("capture") or {}
    parsed = None
    if any(isinstance(e, str) and e.startswith("$") for e in cap.values()):
        try:
            parsed = json.loads(out)
        except Exception:
            parsed = None
    for var, expr in cap.items():
        if isinstance(expr, str) and expr.startswith("$") and parsed is not None:
            vals = jsonpath.resolve(vs.expand(expr), parsed)
            vs.set(var, vals[0] if vals else "")
        else:
            vs.set(var, out)  # capture whole stdout


def _do_kafka(sb, ctx, dry_run):
    if dry_run:
        return
    from . import kafka
    ok, msg = kafka.produce(sb["kafka"], ctx["scripts_dir"], ctx["varstore"])
    if not ok:
        raise RuntimeError(f"setup kafka produce failed: {msg}")


def _do_vars(sb, ctx):
    # Inline assignment — runs even on dry-run (no I/O, and later step labels
    # may reference the vars). Values are expanded, so `${OTHER}` refs work.
    vs = ctx["varstore"]
    for k, v in (sb["vars"] or {}).items():
        vs.set(k, vs.expand(str(v)))


_HANDLERS = {}  # filled at the bottom, once every handler is defined


def _do_redis(sb, ctx, dry_run):
    if dry_run:
        return
    for line in ctx["varstore"].expand(sb["redis"]).splitlines():
        line = line.strip()
        if not line:
            continue
        cmd = line if line.startswith("redis-cli") else f"redis-cli {line}"
        proc.run(cmd, step_timeout(sb, ctx))


_HANDLERS.update(sql=_do_sql, seed=_do_seed, http=_do_http, redis=_do_redis,
                 exec=_do_exec, kafka=_do_kafka)
