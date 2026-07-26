#!/bin/sh
set -e

# `docker compose run --rm app sync [--flags]` → run the CLI once and exit.
# Used for provisioning (`sync --setup-only`) and manual/ad-hoc syncs.
if [ "$1" = "sync" ]; then
  shift
  exec node /app/dist/index.js "$@"
fi

# Default (`docker compose up`) → resident scheduler. supercronic stays up as
# PID 1 and spawns a fresh `node` process per scheduled run, so each sync gets
# a clean SQLite connection and honest exit codes.
exec supercronic /app/crontab
