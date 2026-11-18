"""Subprocess execution with a hard timeout and an opt-in retry.

Without a timeout one hung `go test` behind an `exec:` step held the whole run
for 40 minutes with no output. Every exec now runs in its own process group so
a timeout kills the command AND its children (a shell pipeline, `go test`'s test
binaries), and the error names the step as hung instead of waiting forever.

Timeout resolution (first set wins): the step's `timeout:`, the test's
`timeout:`, `config.step_timeout`, env CHECKLIST_STEP_TIMEOUT, DEFAULT_TIMEOUT.
Values are seconds (int) or a duration string: "90s", "5m", "1h".
"""
import os
import re
import signal
import subprocess
import time

DEFAULT_TIMEOUT = 300  # seconds — a single step slower than 5 minutes is a hang until said otherwise

_DUR_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$", re.IGNORECASE)
_UNIT = {None: 1, "ms": 0.001, "s": 1, "m": 60, "h": 3600}


def parse_duration(value):
    """Seconds as a float, or None when unset. Raises ValueError on a bad value."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"invalid duration {value!r}")
    if isinstance(value, (int, float)):
        if value <= 0:
            raise ValueError(f"invalid duration {value!r} — must be > 0")
        return float(value)
    m = _DUR_RE.match(str(value))
    if not m:
        raise ValueError(f"invalid duration {value!r} — use seconds or e.g. \"90s\", \"5m\", \"1h\"")
    secs = float(m.group(1)) * _UNIT[(m.group(2) or "").lower() or None]
    if secs <= 0:
        raise ValueError(f"invalid duration {value!r} — must be > 0")
    return secs


def default_timeout(cfg=None):
    """The run-wide default: config.step_timeout > CHECKLIST_STEP_TIMEOUT > DEFAULT_TIMEOUT."""
    for v in ((cfg or {}).get("step_timeout"), os.environ.get("CHECKLIST_STEP_TIMEOUT")):
        t = parse_duration(v)
        if t:
            return t
    return float(DEFAULT_TIMEOUT)


def _fmt(secs):
    if secs >= 60 and secs % 60 == 0:
        return f"{int(secs // 60)}m"
    return f"{secs:g}s"


class StepTimeout(RuntimeError):
    pass


def run(cmd, timeout, shell=True, input_text=None):
    """Run `cmd`, killing its whole process group after `timeout` seconds.

    Returns CompletedProcess (text). Raises StepTimeout on a hang."""
    proc = subprocess.Popen(cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                            text=True, start_new_session=True)
    try:
        out, err = proc.communicate(input=input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        label = cmd if isinstance(cmd, str) else " ".join(cmd)
        raise StepTimeout(f"step hung: no exit after {_fmt(timeout)}, killed — {label.strip()[:300]} "
                          f"(raise it with `timeout:` on the step if this command is legitimately slow)")
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


def _kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass
    deadline = time.time() + 3
    while proc.poll() is None and time.time() < deadline:
        time.sleep(0.05)
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass


def run_with_retry(cmd, timeout, retry=0, retry_on=None, on_retry=None):
    """run() plus `retry:` — re-run a non-zero exit up to `retry` more times.

    `retry_on:` (regex) narrows it to failures whose stdout+stderr match, e.g.
    "context deadline exceeded" for a migration lock lost to a parallel run, so a
    real assertion failure is not retried into a false green. A timeout is never
    retried: a hang that repeats would only double the wait."""
    attempts = 1 + max(0, int(retry or 0))
    pat = re.compile(retry_on) if retry_on else None
    for i in range(attempts):
        proc = run(cmd, timeout)
        if proc.returncode == 0 or i == attempts - 1:
            return proc
        if pat and not pat.search((proc.stdout or "") + (proc.stderr or "")):
            return proc
        if on_retry:
            on_retry(i + 1, proc)
    return proc
