#!/usr/bin/env bash
# Start/stop the local Postgres cluster.
#
# Prefers a userspace install (no Docker, no sudo, no Homebrew) and falls back to
# whatever pg_ctl is on PATH. Override the location with PGBIN / PGDATA.
set -euo pipefail

PGBIN="${PGBIN:-$HOME/.local/pgsql/bin}"
PGDATA="${PGDATA:-$HOME/.local/pgdata-foodhub}"
PGPORT="${PGPORT:-5433}"
PGSOCKET="${PGSOCKET:-/tmp}"

if [ ! -x "$PGBIN/pg_ctl" ]; then
  PGBIN="$(dirname "$(command -v pg_ctl || true)")" || true
fi
if [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "pg_ctl not found. Set PGBIN, or run 'docker compose up -d postgres' instead." >&2
  exit 1
fi

case "${1:-start}" in
  init)
    [ -d "$PGDATA" ] || "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust
    ;;
  start)
    if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
      echo "Postgres already running on :$PGPORT"
    else
      "$PGBIN/pg_ctl" -D "$PGDATA" -l /tmp/foodhub-pg.log -o "-p $PGPORT -k $PGSOCKET" start
    fi
    ;;
  stop)
    "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast
    ;;
  status)
    "$PGBIN/pg_ctl" -D "$PGDATA" status
    ;;
  *)
    echo "usage: pg.sh [init|start|stop|status]" >&2
    exit 1
    ;;
esac
