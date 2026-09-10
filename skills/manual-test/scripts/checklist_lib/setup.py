"""Setup/teardown step executor.

Each step is one of:
  - sql: "..."            run SQL (optional `capture: {VAR: ...}` → first scalar;
                          optional `expect:` → pre-state GUARD, aborts the test on
                          mismatch. Scalar expect asserts; dict expect is descriptive.
                          optional `db_ref:` → another service's database.)
  - seed: name            run the named snippet from the top-level `seed:` map
                          (optional `db_ref:`)
  - http: {...}           call an endpoint (optional `capture: {VAR: "$.json.path"}`)
  - redis: |              run redis-cli line(s)
  - exec: "cmd"           run a project command; capture stdout into vars
                          (optional `capture: {VAR: "$.json.path"}` if the command
                          prints JSON, else `{VAR: stdout}` captures the whole output).
                          Generic escape hatch: request signing, token minting, any
                          pre-compute lives in the PROJECT's script — not in this runner.
  - vars: {NAME: value}   set variables inline (values are ${VAR}-expanded)

`ctx` carries: db, dbs, scripts_dir, base_url, base_urls, varstore, tokens, doc.
"""
import json
import subprocess

from . import http, jsonpath, sql


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
    if "sql" in sb:
        _do_sql(sb, ctx, dry_run)
    elif "seed" in sb:
        _do_seed(sb, ctx, dry_run)
    elif "http" in sb:
        _do_http(sb, ctx, dry_run)
    elif "redis" in sb:
        _do_redis(sb, ctx, dry_run)
    elif "exec" in sb:
        _do_exec(sb, ctx, dry_run)
    elif "vars" in sb:
        _do_vars(sb, ctx)


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


def _do_http(sb, ctx, dry_run):
    if dry_run:
        return
    vs, h = ctx["varstore"], sb["http"]
    method = (h.get("method") or "GET").upper()
    path = vs.expand(h.get("path", ""))
    headers = {}
    tname = h.get("token")
    if tname and tname in ctx["tokens"]:
        k, v = ctx["tokens"][tname]
        headers[k] = v
    for hk, hv in (h.get("headers") or {}).items():
        headers[hk] = vs.expand(str(hv))
    body = vs.expand_obj(h.get("body"))
    ref = h.get("base_url_ref")
    base = (ctx.get("base_urls") or {}).get(ref) if ref else ctx["base_url"]
    if ref and not base:
        raise RuntimeError(f"unknown base_url_ref '{ref}' — define it under config.base_urls")
    url = http.build_url(base, path, vs.expand_obj(h.get("query") or {}))
    status, jbody, _ = http.do_request(method, url, headers, body)
    if status >= 400:
        raise RuntimeError(f"setup http {method} {path} → {status}")
    # `capture:` is documented and templated as nested INSIDE the `http:` block
    # (sibling of method/path/token/body — see templates/CHECKLIST.yaml and this
    # module's own docstring), not as a sibling of `http:` at the step level (that
    # convention is `exec`'s, whose payload is a bare string with nowhere else to
    # put it). Reading `sb.get("capture")` here always missed it — silently: no
    # exception, just an empty dict, so every http-setup capture ever set its var
    # to "" via the fallback below instead of raising a clear error. `h` IS
    # `sb["http"]`, so `h.get("capture")` is where the value actually lives.
    for var, expr in (h.get("capture") or {}).items():
        vals = jsonpath.resolve(vs.expand(expr), jbody) if jbody is not None else []
        vs.set(var, vals[0] if vals else "")


def _do_exec(sb, ctx, dry_run):
    if dry_run:
        return
    vs = ctx["varstore"]
    cmd = vs.expand(sb["exec"])
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"setup exec failed ({proc.returncode}): {cmd}\n{(proc.stderr or '').strip()[:200]}")
    out = (proc.stdout or "").strip()
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


def _do_vars(sb, ctx):
    # Inline assignment — runs even on dry-run (no I/O, and later step labels
    # may reference the vars). Values are expanded, so `${OTHER}` refs work.
    vs = ctx["varstore"]
    for k, v in (sb["vars"] or {}).items():
        vs.set(k, vs.expand(str(v)))


def _do_redis(sb, ctx, dry_run):
    if dry_run:
        return
    for line in ctx["varstore"].expand(sb["redis"]).splitlines():
        line = line.strip()
        if not line:
            continue
        cmd = line if line.startswith("redis-cli") else f"redis-cli {line}"
        subprocess.run(cmd, shell=True, capture_output=True)
