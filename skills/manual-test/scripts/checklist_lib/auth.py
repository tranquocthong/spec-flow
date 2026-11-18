"""Token resolution — returns (header_name, header_value) for a token def.

Six forms:
  auth: keycloak_ropc                 → kc-ropc.sh password grant → Bearer
  type: keycloak-client-credentials   → OAuth2 client_credentials grant
  payload: '<json>'                   → base64 → X-Userinfo (Summer/APISIX)
  bearer: '<jwt-or-${ENV_VAR}>'       → literal pre-minted token → Bearer
  cookie: '<name>=<value-or-${ENV_VAR}>' → literal Cookie header, no prefix
                                         (cookie-session APIs, e.g. a login
                                         step captures Set-Cookie into an env
                                         var and this passes it through as-is)
  http: {method, path, body, ...}     → call the APP's own login/register endpoint
  token_path: "$.json.path"             and send the token it returns as Bearer
  capture: {VAR: "$.json.path"}         (optional: also keep e.g. the account id)
  scope: run | suite | test             (default run; `test` mints a fresh one —
                                         i.e. a fresh account — for every test)

Tokens are LAZY: a token is resolved only when a test (or setup step) uses it,
never up front. Resolving every declared token before the first suite killed a
whole run with exit 2 because one unused token's env var was empty, and it made
a token captured by a setup step impossible to declare at all. `bearer:` /
`cookie:` / `payload:` are re-expanded on every use, so `bearer: "${TOK}"` works
with a TOK captured earlier in the same test; the network forms are cached per
their `scope:`.

Token-def string fields are ${VAR}-expanded before use (e.g. ${USER_ID}).
"""
import base64
import os
import subprocess
import urllib.parse
import urllib.request


def resolve_token(tok_def, scripts_dir, varstore):
    td = varstore.expand_obj(tok_def)

    if td.get("auth") == "keycloak_ropc":
        cmd = [
            os.path.join(scripts_dir, "kc-ropc.sh"),
            td["realm"], td["client"], td["username"], td["password"],
        ]
        if td.get("client_secret"):
            cmd.append(td["client_secret"])
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().strip()
            return ("Authorization", f"Bearer {out}")
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"kc-ropc.sh failed: {e}") from e

    if td.get("type") == "keycloak-client-credentials":
        data = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": td["client_id"],
            "client_secret": td["client_secret"],
        }).encode()
        req = urllib.request.Request(
            td["token_url"], data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                import json
                jwt = json.loads(resp.read()).get("access_token", "")
            if not jwt:
                raise RuntimeError("no access_token in response")
            prefix = td.get("header_prefix", "Bearer ").rstrip()
            return (td.get("header", "Authorization"), f"{prefix} {jwt}")
        except Exception as e:
            raise RuntimeError(f"client_credentials grant failed: {e}") from e

    if "payload" in td:
        enc = base64.b64encode(td["payload"].encode()).decode().rstrip("\n")
        return ("X-Userinfo", enc)

    if "bearer" in td:
        if not td["bearer"]:
            raise RuntimeError("bearer token def resolved to an empty value (check the env var it references)")
        return (td.get("header", "Authorization"), f"Bearer {td['bearer']}")

    if "cookie" in td:
        if not td["cookie"]:
            raise RuntimeError("cookie token def resolved to an empty value (check the env var it references)")
        return (td.get("header", "Cookie"), td["cookie"])

    raise ValueError(f"unsupported token def: {tok_def}")


# Forms resolved from local values only — cheap, so re-expanded on every use.
_STATIC_KEYS = ("bearer", "cookie", "payload")
_SCOPES = ("run", "suite", "test")


def is_static(tok_def):
    return isinstance(tok_def, dict) and any(k in tok_def for k in _STATIC_KEYS)


def mint_http_token(td, ctx, call):
    """`http:` token: call the app's own endpoint, pick the token out of the JSON.

    `call(spec, ctx)` is setup.http_call — the same request path a setup `http:`
    step uses (base_url_ref, headers, var expansion, expect_status)."""
    from . import jsonpath
    path = td.get("token_path")
    if not path:
        raise RuntimeError("an `http:` token needs `token_path:` — the JSON path of the token in the response")
    status, jbody, raw = call(td["http"], ctx)
    vals = jsonpath.resolve(path, jbody) if jbody is not None else []
    tok = vals[0] if vals else ""
    if not tok:
        raise RuntimeError(f"no token at {path} in the {status} response: {(raw or '')[:200]}")
    vs = ctx["varstore"]
    for var, expr in (td.get("capture") or {}).items():
        got = jsonpath.resolve(vs.expand(expr), jbody) if jbody is not None else []
        vs.set(var, got[0] if got else "")
    prefix = td.get("header_prefix", "Bearer ").rstrip()
    return (td.get("header", "Authorization"), f"{prefix} {tok}" if prefix else str(tok))


def header_for(name, ctx):
    """(header, value) for a declared token name. Raises RuntimeError when the name
    is undeclared or the token cannot be resolved.

    ctx["tokens"] maps name -> either a resolved (header, value) tuple or the raw
    token def (resolved here, lazily, and cached per its scope)."""
    tokens = ctx.get("tokens") or {}
    if name not in tokens:
        known = ", ".join(sorted(tokens)) or "(none declared)"
        raise RuntimeError(f"unknown token '{name}' — declared tokens: {known}. "
                           f"For an unauthenticated request use `token: none` or omit `token:`.")
    entry = tokens[name]
    if isinstance(entry, tuple):
        return entry
    vs = ctx["varstore"]
    if is_static(entry):
        try:
            return resolve_token(entry, ctx["scripts_dir"], vs)
        except Exception as e:
            raise RuntimeError(f"token '{name}' resolution failed: {e}") from e
    cache = ctx.setdefault("_token_cache", {})
    scope = str(entry.get("scope") or "run")
    if scope not in _SCOPES:
        raise RuntimeError(f"token '{name}': invalid scope {scope!r} — use run, suite or test")
    key = (name, ctx.get("_scope_ids", {}).get(scope))
    hit = cache.get(key)
    if hit is not None:
        if isinstance(hit, Exception):
            raise hit
        return hit
    try:
        if "http" in entry:
            from .setup import http_call
            got = mint_http_token(vs.expand_obj({k: v for k, v in entry.items() if k != "http"})
                                  | {"http": entry["http"]}, ctx, http_call)
        else:
            got = resolve_token(entry, ctx["scripts_dir"], vs)
    except Exception as e:
        # Cache the failure too: every later test using this token fails fast with
        # the same cause instead of re-running a broken login per test.
        fail = RuntimeError(f"token '{name}' resolution failed: {e}")
        cache[key] = fail
        raise fail from e
    cache[key] = got
    return got


def begin_scope(ctx, scope, ident):
    """Mark a new suite/test so `scope: suite|test` tokens are minted afresh."""
    ctx.setdefault("_scope_ids", {})[scope] = ident


def tokens_used_by(test):
    """Token names a test references (setup/teardown http steps + request)."""
    names = []
    for step in (test.get("setup") or []) + (test.get("teardown") or []):
        if isinstance(step, dict) and isinstance(step.get("http"), dict) and step["http"].get("token"):
            names.append(step["http"]["token"])
    tok = (test.get("request") or {}).get("token")
    if tok:
        names.append(tok)
    return names
