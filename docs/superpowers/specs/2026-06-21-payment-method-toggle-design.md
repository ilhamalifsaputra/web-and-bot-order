# Payment-method on/off toggle (web admin) — design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan

## Problem

The web admin can configure credentials for each payment method, but there is no
clean way to *disable* a method while keeping its keys. Today:

- **TokoPay / PayDisini / NOWPayments** already read an `*_enabled` setting key
  (`getTokopayCreds` / `getPaydisiniCreds` / `getNowpaymentsCreds` return `null`
  when the value is the literal string `"false"`). But the only way to change it
  is to type `true`/`false` into a raw text field on the Settings page.
- **Bybit / Binance Internal** have **no** toggle at all — `resolveBybitConfig` /
  `resolveBinanceInternalConfig` derive `enabled` purely from credential presence.
  The only way to disable them is to wipe their API keys.

We want a real on/off switch per method in **Settings → Payments**.

## Goal

A per-method on/off toggle in the web admin that disables/enables a payment
method **without** touching its credentials, with audit logging and a clear UI.

## Scope

The **5 active methods**: TokoPay, PayDisini, NOWPayments, Bybit, Binance
Internal. The legacy manual Binance Pay flow is retired and out of scope.

Non-goals:
- No new payment methods.
- No change to how credentials are entered/validated.
- No change to the reconcile pollers' behavior (see Caveat).

## Design decisions (confirmed with user)

1. **Placement:** toggles live on the existing **Settings → Payments** tab, in
   each method's card header — not a separate page.
2. **Toggle logic:** the switch is *independent* of credentials. A method is
   shown to customers only if it is **toggled on AND** its credentials are
   configured. The toggle alone never exposes a method with missing keys.

## Data layer

Toggle state is stored in the shared `settings` table as a per-method
`*_enabled` key.

- Existing keys (unchanged): `tokopay_enabled`, `paydisini_enabled`,
  `nowpayments_enabled`.
- **New keys:** `bybit_enabled`, `binance_internal_enabled`.

**Semantics (match the existing convention byte-for-byte):**
- Default **ON**: an unset/empty value means enabled.
- Only the literal string `"false"` (case-insensitive, trimmed) disables.
- This is backward-compatible: existing installs have no `*_enabled` rows for
  Bybit/Binance, so they stay enabled exactly as before.

**Resolver changes** (`packages/db/src/crud/`):
- `resolveBybitConfig`: add a `BYBIT_ENABLED_KEY` read; set
  `enabled = Boolean(depositAddress && apiKey && apiSecret) && flag !== "false"`.
- `resolveBinanceInternalConfig`: add a `BINANCE_INTERNAL_ENABLED_KEY` read; set
  `enabled = Boolean(receiveUid && apiKey && apiSecret) && flag !== "false"`.
- The three IDR/NOWPayments getters already honor their flag — no change.

**Single source of truth:** the bot checkout (`apps/order-bot`) and the
storefront (`apps/storefront`) both read these same crud getters, so one toggle
controls method visibility everywhere — bot and website alike.

## Web-admin route

New route in `apps/web-admin/src/routes/settings.ts`:

`POST /settings/payments/toggle` — preHandler `csrfProtect`.
- Body: `method` (one of a fixed set) + `enabled` (`"true"`/`"false"`).
- Validates `method` against a fixed map `{ method -> { enabledKey, label } }`
  (the whitelist guardrail — never write an arbitrary settings key).
- Writes `"true"`/`"false"` to the mapped `*_enabled` key via `setSetting`.
- Audits via `logAdminAction` (`action: "payment_method_toggle"`,
  `targetType: "setting"`, `details: "<key>=<value>"`).
- Redirects back to `/settings` with a success flash.

The five `*_enabled` keys are added to (or kept in) the `EDITABLE` whitelist and
their respective `PAY_*_KEYS` groups, so the generic settings table/flow stays
consistent and the new keys never "silently disappear" from the page.

## UI (Settings → Payments)

Each of the 5 method cards gets a toggle control in its header, mirroring the
existing 2FA on/off pattern already on the page:

- A status pill: **On** (`chip bg-grass-tint text-grass-dark`) / **Off**
  (`chip bg-sand text-ink-soft`).
- A single-button form posting to `/settings/payments/toggle`:
  **"Turn off"** (when on) / **"Turn on"** (when off), carrying the method id and
  the opposite of the current state.
- When toggled **On but credentials are missing**, an amber hint near the toggle:
  *"Add the keys below to go live."* — so the admin understands toggle-on alone
  doesn't make the method available.
- A short note that disabling a method stops new orders on it and that any
  in-flight pending orders on that method should be drained first (see Caveat).

The GET `/settings` handler computes, per method, two booleans passed to the
template: `enabled` (flag state) and `configured` (credentials present), so the
pill/hint render accurately.

No new i18n: the web admin is English-only (not routed through `t()`).

## Caveat (surfaced in UI copy)

Disabling a method makes its reconcile poller short-circuit
(`if (!creds) return;` / `if (!cfg.enabled) return;`), so an **in-flight pending
order** on that method stops auto-confirming and will eventually expire/cancel.
This is already today's behavior for the three flagged methods; the toggle UI
will carry a short warning so the admin drains pending orders before turning a
method off. No change to poller logic is in scope.

## Testing

- **crud unit tests** (`packages/db/src/crud/*.test.ts`, colocated):
  - `resolveBybitConfig` — enabled when creds present and flag unset/`"true"`;
    disabled when flag `"false"`; still disabled when creds missing regardless of
    flag.
  - `resolveBinanceInternalConfig` — same matrix.
- **web-admin route trio** for `POST /settings/payments/toggle`:
  - happy path (valid method + csrf → flag written, redirect+flash, audit row),
  - auth-fail (no session → rejected),
  - bad-csrf (missing/invalid token → rejected).
- `pnpm typecheck` + `pnpm test` stay green.

## Files touched (anticipated)

- `packages/db/src/crud/bybit_deposit.ts` — `BYBIT_ENABLED_KEY` + resolver clause.
- `packages/db/src/crud/binance_internal.ts` — `BINANCE_INTERNAL_ENABLED_KEY` +
  resolver clause.
- `packages/db/src/crud/bybit_deposit.test.ts`,
  `packages/db/src/crud/binance_internal.test.ts` — flag matrix tests.
- `apps/web-admin/src/routes/settings.ts` — EDITABLE keys, groups, toggle route,
  per-method state in GET.
- `apps/web-admin/views/settings.njk` — toggle control in each method card.
- `apps/web-admin/test/*` — route trio for the toggle.
