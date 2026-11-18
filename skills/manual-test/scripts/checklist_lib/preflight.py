"""Preflight: list every variable the selected tests need that nothing provides.

A ${VAR} with no `:-default` that is not declared in config.vars, not captured
or assigned by any step, and not set in the environment expands to "" — which
surfaces much later as a 401, an empty SQL literal or a blank curl argument that
reads like an app bug. Checked once, before anything runs, with where each one
is used.
"""
import os
import re

_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}")
_BUILTIN = {"TEST_CORRELATION_ID", "TEST_START"}


def _refs(node, where, out):
    if isinstance(node, str):
        for m in _REF_RE.finditer(node):
            if m.group(2) is None:
                out.setdefault(m.group(1), where)
    elif isinstance(node, dict):
        for k, v in node.items():
            _refs(v, f"{where}.{k}", out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _refs(v, f"{where}[{i}]", out)


def _provided(node, out):
    """Names some step assigns: capture keys, `vars:` step keys, http-token captures."""
    if isinstance(node, dict):
        for key in ("capture", "vars"):
            val = node.get(key)
            if isinstance(val, dict):
                out.update(str(k) for k in val)
        for v in node.values():
            _provided(v, out)
    elif isinstance(node, list):
        for v in node:
            _provided(v, out)


def missing(doc, selected, token_names, varstore):
    """[(name, first place it is used)] for the run about to start.

    selected: [(suite, [tests])] — only suites/tests that will actually run.
    token_names: token names those tests use (their defs are scanned too)."""
    used = {}
    cfg = doc.get("config") or {}
    _refs({k: v for k, v in cfg.items() if k != "vars"}, "$.config", used)
    _refs(doc.get("cleanup"), "$.cleanup", used)
    tokens = doc.get("tokens") or {}
    for name in token_names:
        if name in tokens:
            _refs(tokens[name], f"$.tokens.{name}", used)
    for suite, tests in selected:
        sid = suite.get("id", "?")
        _refs(suite.get("setup"), f"suite {sid} setup", used)
        for t in tests:
            _refs({k: v for k, v in t.items() if k not in ("name", "note", "description")},
                  f"{t.get('id', '?')}", used)
    provided = set(_BUILTIN) | set((cfg.get("vars") or {}).keys())
    _provided(doc, provided)
    out = []
    for name, where in used.items():
        if name in provided:
            continue
        if varstore.get(name) or os.environ.get(name):
            continue
        out.append((name, where))
    return sorted(out)
