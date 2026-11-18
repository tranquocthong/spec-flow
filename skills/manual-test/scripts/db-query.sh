#!/usr/bin/env bash
# db-query.sh — 1-shot Postgres query with auto-discovered creds.
# Usage:
#   scripts/db-query.sh "SELECT * FROM accounts LIMIT 1"
#   scripts/db-query.sh -d other_db "SELECT 1"           # override DB
#   scripts/db-query.sh -f path/to/file.sql              # run file
#   scripts/db-query.sh -t "SELECT ..."                  # tuples-only (no headers)
#   scripts/db-query.sh -r /path/to/project "SELECT 1"   # use creds from another project root
#   scripts/db-query.sh --host db2 --port 2432 -d payment_db "SELECT 1"   # another server
#
# Credentials resolved by db-creds.sh (from .env / application.yml). See that script for order.
# --host/--port/--user/--password override individual discovered fields; anything not
# overridden still comes from db-creds.sh, so a second DB on the SAME server needs only -d.

set -u

ROOT="."
SQL=""
SQL_FILE=""
DB_OVERRIDE=""
HOST_OVERRIDE=""
PORT_OVERRIDE=""
USER_OVERRIDE=""
PASS_OVERRIDE=""
PASS_SET=0
PSQL_FLAGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -d) DB_OVERRIDE="$2"; shift 2 ;;
    --host) HOST_OVERRIDE="$2"; shift 2 ;;
    --port) PORT_OVERRIDE="$2"; shift 2 ;;
    --user) USER_OVERRIDE="$2"; shift 2 ;;
    --password) PASS_OVERRIDE="$2"; PASS_SET=1; shift 2 ;;
    -f) SQL_FILE="$2"; shift 2 ;;
    -t) PSQL_FLAGS+=(-t); shift ;;
    -r) ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,15p' "$0" >&2
      exit 0
      ;;
    -*) PSQL_FLAGS+=("$1"); shift ;;
    *) SQL="$1"; shift ;;
  esac
done

if [ -z "$SQL" ] && [ -z "$SQL_FILE" ]; then
  echo "Error: pass SQL string or -f file" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$("$HERE/db-creds.sh" "$ROOT")" || { echo "db-creds.sh failed" >&2; exit 2; }

DB="${DB_OVERRIDE:-$PG_DB}"
HOST="${HOST_OVERRIDE:-$PG_HOST}"
PORT="${PORT_OVERRIDE:-$PG_PORT}"
USER="${USER_OVERRIDE:-$PG_USER}"
# An explicit --password "" is a real value (trust/peer auth), so track "was it set"
# rather than testing for emptiness.
[ "$PASS_SET" -eq 1 ] && PASS="$PASS_OVERRIDE" || PASS="$PG_PASS"

# Which psql. Default: `psql` on PATH. Configurable (run-checklist.sh exports these
# from .spec-flow/config.json manualTest.psql) for machines without a local client:
#   SF_PSQL="<command prefix>"   — e.g. a versioned binary or a wrapper script; gets
#                                  the same arguments psql would.
#   SF_PSQL_CONTAINER=<name>     — run psql INSIDE that Docker container. Host and port
#                                  are dropped (inside the container the server is
#                                  local); user, password, database, PGOPTIONS kept;
#                                  a -f file is streamed over stdin.
if [ -n "${SF_PSQL_CONTAINER:-}" ]; then
  command -v docker >/dev/null 2>&1 || { echo "Error: SF_PSQL_CONTAINER=$SF_PSQL_CONTAINER but docker is not on PATH" >&2; exit 127; }
  DOCKER_ENV=(-e "PGPASSWORD=$PASS")
  [ -n "${PGOPTIONS:-}" ] && DOCKER_ENV+=(-e "PGOPTIONS=$PGOPTIONS")
  if [ -n "$SQL_FILE" ]; then
    docker exec -i "${DOCKER_ENV[@]}" "$SF_PSQL_CONTAINER" psql -U "$USER" -d "$DB" \
      "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -f - < "$SQL_FILE"
  else
    docker exec "${DOCKER_ENV[@]}" "$SF_PSQL_CONTAINER" psql -U "$USER" -d "$DB" \
      "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -c "$SQL" </dev/null
  fi
  exit $?
fi

# shellcheck disable=SC2206
PSQL_CMD=(${SF_PSQL:-psql})
if ! command -v "${PSQL_CMD[0]}" >/dev/null 2>&1; then
  echo "Error: ${PSQL_CMD[0]} not found on PATH — install a psql client, or set manualTest.psql in" \
       ".spec-flow/config.json: \"<psql command>\" or {\"container\": \"<postgres container>\"}" >&2
  exit 127
fi

if [ -n "$SQL_FILE" ]; then
  PGPASSWORD="$PASS" "${PSQL_CMD[@]}" -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" \
    "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -f "$SQL_FILE"
else
  PGPASSWORD="$PASS" "${PSQL_CMD[@]}" -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" \
    "${PSQL_FLAGS[@]+"${PSQL_FLAGS[@]}"}" -c "$SQL"
fi
