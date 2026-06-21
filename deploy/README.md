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

## Deployment checklist (public release)

- [ ] nginx installed, `nginx -t` clean, 80→443 redirect works.
- [ ] TLS valid on both subdomains (`curl -I` → 200; cert not expired).
- [ ] `.env`: `WEB_COOKIE_SECURE=true`.
- [ ] `docker compose ps` — all 4 services up, healthchecks green.
- [ ] `GET /healthz` (admin + shop) → 200; `GET /login` → 200.
- [ ] Backup cron active (`deploy/backup/README.md`); one restore rehearsed.

## 502 runbook

A 502/504 from nginx means the upstream app didn't answer. Triage in order:

1. **Is the app up?** `docker compose ps` — is web-admin/storefront `Up`/healthy?
   - Down/restarting → `docker compose logs --tail=100 web-admin`. Common: DB
     migration mismatch (`P2022`) — apply schema then restart (CLAUDE.md), or a
     boot crash (bad `.env`).
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
