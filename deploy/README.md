# Deployment — public release (execution/02)

Reverse proxy + TLS (H-2), backup/restore (M-5 — see `deploy/backup/`), and
container surface verification (M-8). Minimal & reversible; every step has a
rollback.

## Topology

```
Internet ──TLS──▶ nginx (443) ──http──▶ 127.0.0.1:8000  web-admin   (admin.example.com)
                                  └────▶ 127.0.0.1:8100  storefront  (shop.example.com)
docker-compose: server (combined: admin + storefront + bot + workers)  (one image, one ./data/bot.db)
```

Apps stay bound to **127.0.0.1** (never exposed directly). nginx terminates TLS.

> **Running more than one shop on this host?** This file covers a single
> instance. To host several **independent** shops (each its own bot, DB, domain,
> and ports) on one VPS, see the **"Banyak toko dalam satu VPS"** section in
> `DOCS.md`.

## H-2 — TLS + reverse proxy

1. DNS: point `admin.` and `shop.` subdomains at the host.
2. Install the config: copy `deploy/nginx/telegram-shop.conf` →
   `/etc/nginx/sites-available/`, symlink into `sites-enabled/`, edit the domain
   + cert paths.
3. Certs: `certbot --nginx -d admin.example.com -d shop.example.com`.
4. `nginx -t && systemctl reload nginx`.
5. **App config (`.env`):** set `WEB_COOKIE_SECURE=true`. Browsers see HTTPS via
   nginx, so session cookies get the Secure flag with **no app change**.
6. Verify: `curl -I https://admin.example.com/login` → `200`; HTTP → `301`.

**Why no `trustProxy` change:** the only consumer of the client IP is the login
lockout (`apps/web-admin/.../auth.ts` `clientIp`), which already reads
`X-Forwarded-For` itself; `req.protocol` isn't used to build URLs. So enabling
Fastify `trustProxy` would change behaviour for no functional gain. Revisit only
if the Fastify request logger is turned on (execution/11) and needs `req.ip`.

## Access log (L-01)

App request logging is `logger: false` today (`*/src/server.ts`) — owned by
execution/11. Until then, **nginx access logs are the request trail**
(`/var/log/nginx/access.log`), which is enough to diagnose a 502.

## M-8 — container surfaces

`docker-compose.yml` runs **one combined `server` service** (`pnpm start`,
apps/server) off the single image. That one process serves every surface and the
in-process workers:

| Service | command | surfaces | ports |
|---|---|---|---|
| server | `pnpm start` | web-admin + storefront + order-bot + outbox dispatcher + payment pollers | `${WEB_PORT:-8000}` (admin), `${STOREFRONT_PORT:-8100}` (storefront) |

The Dockerfile default `CMD` is also `pnpm start`, so `docker run` without a
compose `command` runs the same combined server. Verify after deploy:
`docker compose config` (service resolves) and `docker compose ps` (`server`
healthcheck green on `/login`).

## Releasing — the database steps are automatic

A release deploys with one command:

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"
DATABASE_URL_PRISMA=postgresql://engine-marker deploy/backup/backup.sh   # see "Take a dump first"
$COMPOSE up -d --build
$COMPOSE logs --since 10m server | grep entrypoint                       # READ these lines
```

`--build` also builds the React SPA bundles (admin + storefront) in the
Dockerfile's builder stage — they are gitignored, so there is no separate client
build step on the Docker path. Then `docker-entrypoint.sh` runs, before the app
process starts and on every start path (`up`, `restart`, and the automatic restart
after a crash):

1. `prisma db push --skip-generate` — never with `--accept-data-loss`, so a change
   that would drop rows fails the push and **the container refuses to start**.
   This is the only fatal step.
2. The ledger chart-of-accounts seed (`scripts/seed-chart-of-accounts.ts`). Every
   ledger posting resolves its account by `code`, so on a database where this has
   never run, order settlements, wallet top-ups and referral commissions record
   nothing at all. Idempotent upsert; a no-op once seeded.
3. The release's data-only migrations (the `$DATA_MIGRATIONS` list in
   `docker-entrypoint.sh`) via `prisma db execute` — `db push` only syncs
   structure, never rows.

**Why step 3 of the deploy command is `grep entrypoint`:** steps 2 and 3 above only
**warn** on failure and let start-up continue, because the schema is already pushed
by then and a container that refuses to start cannot be used to repair anything.
The seed also exits non-zero for a *drifted chart* — an account classified
differently from `CHART_OF_ACCOUNTS`, or an active account the chart no longer
lists — which is an accounting decision about rows that may already carry posted
entries, not a deploy failure. Those warnings are visible nowhere else.

Opting out: `AUTO_MIGRATE=0` in `.env`, or `deploy/backup/restore.sh`'s
`data/SKIP_AUTO_MIGRATE` sentinel for one boot after a rollback. Then the steps are
yours: `$COMPOSE run --rm server pnpm exec prisma db push --schema
prisma/schema.prisma` and `$COMPOSE run --rm server pnpm seed-chart-of-accounts`.
Full reference: `docs/MIGRATIONS.md`.

### Take a dump first

The entrypoint takes **no** pre-deploy snapshot on the Postgres path. The Postgres
branch of `deploy/backup/backup.sh` dumps by running `pg_dump` *inside* the
`postgres` container over a Docker socket the `server` container does not have, and
shipping `postgresql-client` in the app image would give a client older than the
`postgres:16` server. So the dump runs on the host, and it is the only rollback
point a deploy has — see **Backup — Postgres** and **Restore — Postgres** in
[`backup/README.md`](backup/README.md). What the entrypoint does guarantee is that
`db push` refuses any change it cannot apply without dropping data.

## Deployment checklist (public release)

- [ ] nginx installed, `nginx -t` clean, 80→443 redirect works.
- [ ] TLS valid on both subdomains (`curl -I` → 200; cert not expired).
- [ ] `.env`: `WEB_COOKIE_SECURE=true`.
- [ ] `docker compose ps` — all 4 services up, healthchecks green.
- [ ] `GET /healthz` (admin + shop) → 200; `GET /login` → 200.
- [ ] Backup cron active (`deploy/backup/README.md`); one restore rehearsed.
- [ ] `logs --since 10m server | grep entrypoint` read: schema pushed, ledger
      chart of accounts seeded, data-only migrations applied, **no `WARNING`**.

## 502 runbook

A 502/504 from nginx means the upstream app didn't answer. Triage in order:

1. **Is the app up?** `docker compose ps` — is `server` `Up`/healthy?
   - Down/restarting → `docker compose logs --tail=100 server`, and look for
     `entrypoint:` lines first. A refused schema push stops the container on
     purpose (`prisma db push` never gets `--accept-data-loss`, so a change that
     would drop rows fails loudly instead of deleting data) — that log line names
     the change; make it additive and deploy again, or set `AUTO_MIGRATE=0` and
     resolve it by hand (`docs/MIGRATIONS.md`). Otherwise: a boot crash (bad
     `.env`), or Postgres not reachable.
   - A `P2022 column ... does not exist` at runtime now means the schema step was
     skipped, not forgotten — check for `AUTO_MIGRATE=0` in `.env` and for a
     leftover `data/SKIP_AUTO_MIGRATE` sentinel from a rollback.
2. **Is it listening on the expected port?** `curl -I http://127.0.0.1:8000/healthz`
   from the host. 200 → nginx/proxy_pass port mismatch. Connection refused →
   app not bound (check `WEB_HOST=0.0.0.0` inside the container).
3. **nginx logs:** `tail -f /var/log/nginx/error.log` — `connect() failed`
   (upstream down) vs `upstream timed out` (slow handler; timeouts are 5s/30s).
4. **Recover:** `docker compose restart server`.
   Confirm `/healthz` 200, then retry through nginx.

## Rollback

- **nginx:** disable the site (`rm sites-enabled/telegram-shop.conf`),
  `systemctl reload nginx`; or revert to the previous config file.
- **TLS-only issue:** comment the 80→443 `return 301` to serve plain HTTP
  temporarily while fixing certs.
- **App/DB:** `deploy/backup/restore.sh <last-good-backup>` (stops writers,
  swaps the DB, integrity-checks, restarts, smoke-tests `/healthz`).
- **Verify post-rollback:** `docker compose ps` green + `/healthz` 200 + `/login` 200.
