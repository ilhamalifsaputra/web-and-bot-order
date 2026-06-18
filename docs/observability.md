# Observability (execution/11)

## Access log (L-01)

Both web apps (`web-admin`, `storefront`) log one line per response via an
`onResponse` hook → the shared pino `logger` (`@app/core/logger`):

```json
{ "level": 30, "method": "GET", "path": "/search", "status": 200, "ms": 4, "msg": "access" }
```

**What is logged:** method, path, status, duration. **What is NOT, by design
(never log secrets — CLAUDE.md):**
- **No query string** — `req.url` is cut at `?`, so reset tokens / `q=` never
  land in logs (verified: a `/search?q=…` request logs `path:"/search"`).
- No request/response **body**, no **headers**, no cookies.

The Telegram bot already tags every log line with `updateId`
(`logger.mixin`); the web access log adds the request trail those lacked.

Until this hook, app logging was `logger:false`; nginx access logs were the only
trail (see `deploy/README.md` 502 runbook). Both now exist and complement each
other (nginx = edge/TLS/upstream-down; app = handler status + timing).

**Level / noise:** logged at `info` (`LOG_LEVEL` default). In CI/tests this adds
a line per `app.inject` — harmless, but set `LOG_LEVEL=warn` to silence if the
test output is too chatty.

## Sensitive-text redaction (L-8)

`bot.catch` (`apps/order-bot/src/main.ts`) used to log
`text=<user message, 120 chars>` — which could be a TxID, a support message, or
other sensitive input. Now it logs `msglen=<n>` only: enough to know a text
update was in flight and correlate via the `ref` shown to the user, without
leaking content. Callback data (`cb=…`) and `user=<id>` are still logged (not
sensitive).

## Audit coverage (L-9)

`logAdminAction` → `audit_log` is called by every mutating admin route. Per-file
`app.post` vs `logAdminAction` counts are ≥ parity across `catalog`, `orders`,
`payments`, `stock`, `settings`, `users`, `vouchers`, `support`, `broadcast`,
`reviews`, `outbox`, `admins`. The few `post`-heavy/`audit`-light files are
expected:
- `branding.ts` audits **inside** `handleUpload` (the `auditAction` option), not
  inline.
- `auth.ts` / `setup.ts` cover login/logout/2FA/forgot/reset and the pre-admin
  setup wizard, which use purpose-specific events (`web_login_failed`,
  `web_setup_completed`) rather than a generic per-route action.

Test-side assertions were added in execution/10 (17 actions incl. `wallet_adjust`);
remaining un-asserted actions are listed in `docs/test-matrix.md` as follow-ups.

## Error tracking (L-10) — optional, deferred

No external error tracker (Sentry/etc.) today. The `ref` correlation id + pino
JSON logs are sufficient at single-shop scale. **Trigger to add one:** sustained
traffic or multi-operator support where grepping log files stops scaling. Wiring
sketch: a pino transport or a `bot.catch` / Fastify `onError` hook that ships
`{ ref, err }` (never the user text — see L-8) to the tracker.

## Log retention

pino writes JSON to stdout; in Docker that's captured by the json-file driver
with rotation already set in `docker-compose.yml` (`max-size: 10m`,
`max-file: 5`). nginx logs rotate via the OS `logrotate`. No app-side retention
needed.
