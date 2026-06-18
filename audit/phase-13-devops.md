# Phase 13 — DevOps Audit

> Read-only.

---

## Konteks Proyek
`Dockerfile` + `docker-compose.yml` (healthcheck `/healthz`, `restart: unless-stopped`).
Non-Docker: pnpm + pm2. Bind **`127.0.0.1` default** → butuh reverse proxy + TLS untuk
publik (CLAUDE.md). Build bundle: `scripts/build-bundle.ts`. Ada **isu historis nginx 502**
setelah deploy (proses app crash) — relevan untuk dicek. CI/CD belum terlihat.

---

## Objective
Temukan misconfiguration infrastruktur & celah rilis publik.

## Langkah Investigasi / Periksa
1. **Dockerfile:** multi-stage? base image versi pin? **user non-root**? layer cache efisien? `data/` sebagai volume (persisten)?
2. **docker-compose.yml:** healthcheck interval/timeout/retries wajar? port mana yang ter-expose ke publik vs internal? volume `data/bot.db` aman?
3. **CI/CD:** ada `.github/workflows/`? Jika tidak → rekomendasikan pipeline minimal (`pnpm -r typecheck` + `npx vitest run`) pada PR.
4. **PM2 (non-Docker):** ada `ecosystem.config.*`? restart policy, log rotation?
5. **Backup:** prosedur backup `data/bot.db` (WAL) terdokumentasi & konsisten (mis. `sqlite3 .backup` atau stop-copy)? Restore teruji?
6. **SSL/TLS & reverse proxy (nginx):** contoh konfig benar? Header proxy (`X-Forwarded-*`) → `WEB_COOKIE_SECURE`/`trustProxy`? Catat akar masalah **502** (app down vs upstream salah).
7. **Healthcheck app:** `/healthz` cek DB (`SELECT 1`), bukan sekadar 200 statis.
8. **Env ke container:** via env_file/secret, **bukan** ter-commit; `.env` di `.gitignore`?

## Output → tulis ke `audit/reports/phase-13-devops.md`
```
ID | Area (dockerfile/compose/ci/pm2/backup/tls/health/env) | Temuan | File | Risiko | Rekomendasi | Prioritas (blok rilis publik?)
```
