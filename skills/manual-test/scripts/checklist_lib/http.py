"""HTTP request execution via curl. Returns (status, body_json_or_None, raw_text)."""
import json
import subprocess
import urllib.parse

_STATUS_MARKER = "\n__HTTP_STATUS__="


def build_url(base_url, path, query):
    url = base_url.rstrip("/") + "/" + path.lstrip("/")
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    return url


def do_request(method, url, headers, body=None, timeout=15):
    cmd = ["curl", "-sS", "-o", "/dev/stdout",
           "-w", _STATUS_MARKER + "%{http_code}",
           "-X", method, "--max-time", str(timeout), url]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    body_text = None
    if body is not None:
        body_text = body if isinstance(body, str) else json.dumps(body)
        cmd += ["-H", "Content-Type: application/json"]
        # `-d @-` reads the body from stdin instead of argv (`-d <body>`): a
        # large attachment (base64, TC-015's 10MB+ case) blew ARG_MAX with
        # "Argument list too long" — a Python-level OSError the whole runner
        # died on, not something the failing test itself could report. stdin
        # has no such ceiling, and this is correct for every body size, not
        # just large ones, so there is no small/large branch to keep in sync.
        cmd += ["-d", "@-"]

    raw = subprocess.run(cmd, capture_output=True, text=True,
                          input=body_text).stdout
    idx = raw.rfind(_STATUS_MARKER)
    if idx < 0:
        return 0, None, raw
    body_text = raw[:idx]
    status = int(raw[idx + len(_STATUS_MARKER):].strip())
    try:
        body_json = json.loads(body_text) if body_text.strip() else None
    except json.JSONDecodeError:
        body_json = None
    return status, body_json, body_text
