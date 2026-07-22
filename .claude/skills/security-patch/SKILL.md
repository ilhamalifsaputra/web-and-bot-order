---
name: security-patch
description: Use when fixing a reported vulnerability, patching a CVE'd dependency, or hardening a specific piece of code against a concrete attack, before writing the fix
---

# Security Patch

## Overview

A security fix in this repo needs two things a normal bug fix doesn't: proof the vulnerability is closed (a regression test that fails before the patch and passes after), and a tight blast radius (the fix should not silently touch adjacent behavior). This project's biggest concrete attack surfaces are the storefront's public auth/forgot-password flow, CSRF on mutating web routes, and secret-bearing values that must never reach a log.

## When to Use

- Fixing a reported or self-discovered vulnerability (XSS, injection, auth bypass, CSRF gap, IDOR, secret leakage, etc.).
- Patching a dependency for a known CVE.
- Hardening `apps/storefront/src/auth.ts`, the forgot-password flow, or any other internet-facing input path.
- Any change explicitly motivated by "this could be exploited if…".

## Where this project is actually exposed

- **Storefront auth + forgot-password** (`apps/storefront/src/auth.ts`) is the public, untrusted-input surface — the storefront is the only app meant to face the internet. Admin (`apps/web-admin`) binds `127.0.0.1` by default and assumes a trusted operator until a reverse proxy + TLS + RBAC/2FA review happens.
- **CSRF**: every mutating route must run the `csrfProtect` preHandler (`csrf_token` form field or `X-CSRF-Token` header). A route missing this on a state-changing action is a real CSRF hole, not a theoretical one — check for it explicitly when reviewing a patch to route code.
- **Secrets in logs**: credentials, payment-proof `file_id`, password hashes, and full DB URLs must never appear in a Pino log, an audit log (`logAdminAction`), or an error message/stack trace that could surface to a user or get persisted. This is the most common accidental-disclosure path in this codebase — a patch that adds a new error path or log line is a patch that can reintroduce this.
- **Settings whitelist**: admin settings writes are whitelist-only; a patch must never widen that whitelist as a side effect of "just making the field work."
- **Telegram delivery**: neither web app talks to Telegram directly (`notification_outbox` only) — a patch should never add a direct Telegram call from web code as a shortcut.

## Patch process

1. Reproduce first: write or identify a test that demonstrates the vulnerability (fails on current code). If the vulnerable path has no test coverage at all, that gap is part of what you're fixing.
2. Fix with the minimum change that closes the hole — don't refactor or "improve" adjacent code in the same patch; scope creep in a security patch makes it harder to review and to backport.
3. Confirm the regression test now passes, then run the full suite: `pnpm typecheck` and `pnpm test` must stay green.
4. Never bypass safety checks to land the patch faster — no `--no-verify`, no skipping the CSRF/auth test trio on a touched route, no disabling a lint/type rule instead of satisfying it.
5. If the fix touches `prisma/schema.prisma` or requires a config/env change, call that out explicitly — schema changes need the DB migrated and order-bot restarted before new code runs (see `money-and-data-integrity` skill).
6. State the vulnerability and the fix in plain terms in the commit message / PR description — what was exploitable, and what specifically closes it. Don't log or print the exploit payload itself anywhere persistent.
