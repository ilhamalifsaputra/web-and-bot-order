---
name: web-fastify-conventions
description: Use when editing apps/web-admin or apps/storefront routes or client code, before writing the code
---

# Web Conventions (Fastify + React SPA)

## Overview

`apps/web-admin` and `apps/storefront` are both Fastify JSON APIs (`/api/v1`-style) behind built React SPAs (`<app>/client`). The two apps share the same contract: every mutation is CSRF-protected, the client is a build artifact that must be rebuilt after edits, and neither app ever talks to Telegram directly.

## When to Use

- Adding or editing a route in `apps/web-admin/src/routes/*` or `apps/storefront/src/routes/*`.
- Editing anything under `apps/web-admin/client/` or `apps/storefront/client/`.
- Adding a feature that needs to notify a user or admin via Telegram from a web request.
- Editing `apps/storefront/src/auth.ts` or the forgot-password flow.

## CSRF on every mutating route

- Every mutating route uses the `csrfProtect` preHandler; admin reads use `currentAdmin`.
- New routes need the full happy/auth-fail/bad-csrf test trio, matching the existing route tests' pattern.
- `csrfCheck` accepts the token two ways: the `csrf_token` form field, or an `X-CSRF-Token` header — the header is the bridge the `apps/web-admin/client` React pages use, so don't remove header support assuming the form field is the only path.

## The client is a build artifact, not source served directly

- `apps/web-admin` is entirely a built React SPA (`apps/web-admin/client`). Run `pnpm --filter @app/web-admin-client build` once after a fresh clone, and again after editing anything under `apps/web-admin/client/`, before `pnpm test` or `pnpm dev:web` will serve it correctly. Output goes to `apps/web-admin/static/dashboard-app/` (gitignored).
- Same contract for the storefront: `pnpm --filter @app/storefront-client build` after cloning or editing `apps/storefront/client/`, output to `apps/storefront/static/shop-app/` (gitignored). The storefront SPA renders its own 500/503 states client-side, with a static HTML fallback only for the rare case the SPA build itself is missing.
- If a web test or `pnpm dev:*` behaves as if your client change didn't happen, rebuild the client first before debugging further.

## Never send Telegram from the web

Neither admin nor storefront ever calls the Telegram API directly. Enqueue a row to `notification_outbox` instead — the outbox-dispatcher/bot delivers it. This applies to any new "notify the customer/admin" feature.

## Settings are whitelist-only

Admin settings edits go through an explicit whitelist — the main guardrail against bricking the bot via a bad config write. Never widen the whitelist without review.

## Exposure and auth posture

- Both apps bind `127.0.0.1` by default; public exposure needs a reverse proxy, TLS, and a stronger auth review (RBAC/2FA) — don't casually change the bind address.
- The storefront is the public-facing surface — treat `apps/storefront/src/auth.ts` and the forgot-password flow as untrusted input, the same way you'd treat any internet-facing auth code.
