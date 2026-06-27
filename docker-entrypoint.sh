#!/bin/sh
# Container entrypoint: fix the bind-mounted data dir's ownership, then drop
# privileges to the non-root `app` user before running the service.
#
# Why: ./data is bind-mounted from the host (docker-compose.yml). A bind mount
# keeps the host's ownership, so after `git clone` the dir is root-owned and the
# non-root runtime user (UID 999) cannot write the SQLite DB — the web-admin
# upsert then fails with "attempt to write a readonly database" (HTTP 500).
# Starting as root lets us chown it, so a fresh clone just works with no manual
# `chown` on the host.
set -e

# chown only when needed (cheap no-op once owned; tolerate read-only mounts).
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /app/data 2>/dev/null || true
  # gosu does not reset HOME; point it at app's home so pnpm/corepack caches are
  # writable (PNPM_HOME is already /pnpm via ENV).
  export HOME=/home/app
  exec gosu app "$@"
fi

# Already non-root (e.g. compose `user:` override) — run as-is.
exec "$@"
