"""Persisted run results: `<checklist dir>/run/last-result.json`.

Written after every real (non dry-run) run, so that
  - `--rerun-failed` can re-run exactly the tests that FAILED last time, and
  - `flow-tools verify-collect --results <that file>` sees the WHOLE checklist,
    not only the slice the last (filtered) run touched.

A filtered run (--tag / --id / --rerun-failed) merges into the previous file:
the tests it ran are replaced, the others keep their last result. An unfiltered
run starts afresh. Ids no longer present in the checklist are dropped either way.

The file has the same shape as the runner's `--json` line, plus `tests[]`:
  {"passed": [...], "failed": [{id, reason}], "notVerified": [{id, reason}],
   "teardownWarnings": [{id, warning}],
   "tests": [{id, suite, suiteName, status: passed|failed|not_verified,
              evidence, reason, at}]}

`run/` also holds the optional `env.sh` (tokens, passwords), so a `.gitignore`
ignoring everything is dropped into it whenever it has none.
"""
import json
import os
from datetime import datetime, timezone

STATUSES = ("passed", "failed", "not_verified")


def path_for(checklist):
    return os.path.join(os.path.dirname(os.path.abspath(checklist)), "run", "last-result.json")


def load(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def failed_ids(data):
    """Ids whose last recorded status is failed (falls back to the `failed` list
    for a file written by an older runner without `tests[]`)."""
    if not data:
        return []
    tests = data.get("tests")
    if isinstance(tests, list):
        return [t["id"] for t in tests if isinstance(t, dict) and t.get("status") == "failed"]
    return [f["id"] if isinstance(f, dict) else str(f) for f in data.get("failed") or []]


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def merge(prev, entries, order, filtered):
    """Combine this run's entries with the previous file.

    entries: {id: entry} for the tests this run executed.
    order:   every test id in the checklist, in file order (drops removed ids).
    filtered: True when only a slice ran — keep the previous result of the rest."""
    old = {}
    if filtered and prev and isinstance(prev.get("tests"), list):
        old = {t.get("id"): t for t in prev["tests"] if isinstance(t, dict)}
    out = []
    for tid in order:
        e = entries.get(tid) or old.get(tid)
        if e:
            out.append(e)
    return out


def payload(tests, teardown_warnings):
    return {
        "passed": [t["id"] for t in tests if t["status"] == "passed"],
        "failed": [{"id": t["id"], "reason": t.get("reason") or "FAIL"}
                   for t in tests if t["status"] == "failed"],
        "notVerified": [{"id": t["id"], "reason": t.get("reason") or "not executed"}
                        for t in tests if t["status"] == "not_verified"],
        "teardownWarnings": teardown_warnings,
        "tests": tests,
    }


def write(path, data):
    run_dir = os.path.dirname(path)
    os.makedirs(run_dir, exist_ok=True)
    gi = os.path.join(run_dir, ".gitignore")
    # Whenever absent (never overwritten): run/ is usually created BY HAND first, to
    # hold env.sh — exactly the file that must not reach git.
    if not os.path.exists(gi):
        with open(gi, "w") as f:
            f.write("# run artifacts and env.sh (may hold tokens) — never commit\n*\n")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)
