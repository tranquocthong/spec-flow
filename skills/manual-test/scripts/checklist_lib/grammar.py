"""The step/verify grammar, in one place, shared by the runner, setup and the linter.

A key the runner does not know used to be a silent no-op: `verify: - exec: ...`
fell through to the kafka dispatcher, which returned "skipped", so the row went
green although its check never ran; `setup: - sleep: 2` likewise did nothing.
Every dispatcher now resolves the kind here and treats None as an error, and the
linter rejects the same shapes before a run starts.
"""

# setup: / teardown: / suite setup: step kinds, in dispatch order.
STEP_KINDS = ("sql", "seed", "http", "redis", "exec", "kafka", "vars")
# Step kinds that execute something whose failure aborts the test. A test whose
# only content is one of these still produces evidence (`exec: ... exit 1` fails).
EXECUTING_STEP_KINDS = frozenset({"sql", "http", "exec", "kafka"})

# verify: item kinds.
VERIFY_KINDS = ("sql", "exec", "kafka_consumer_lag", "kafka_dlt", "kafka_topic")


def step_kind(step):
    """The kind of a setup/teardown step, or None when it carries no known key."""
    if not isinstance(step, dict):
        return None
    for k in STEP_KINDS:
        if k in step:
            return k
    return None


def verify_kind(item):
    """The kind of a verify item, or None when it carries no known key."""
    if not isinstance(item, dict):
        return None
    for k in VERIFY_KINDS:
        if k in item:
            return k
    return None


def describe_unknown(node, known):
    keys = ", ".join(sorted(node)) if isinstance(node, dict) else type(node).__name__
    return f"unknown keys ({keys}) — expected one of: {', '.join(known)}"
