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
#
# The ABSOLUTE path is required, not cosmetic: as PID 1 supercronic installs a
# process reaper and then re-executes itself via syscall.Exec(os.Args[0], ...),
# which does NOT search PATH. Invoked as bare `supercronic`, argv[0] has no
# directory, the re-exec fails with ENOENT, and the container dies on boot with
# "Failed to fork exec: no such file or directory".
exec /usr/local/bin/supercronic /app/crontab
