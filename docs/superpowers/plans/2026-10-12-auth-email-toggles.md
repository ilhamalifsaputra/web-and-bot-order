# Trustance auth, email, toggles implementation plan

**Goal:** Execute the supplied audited spec with truthful delivery status, working Telegram auth, source templates, and ON/OFF controls.
**Spec:** `C:/Users/ilham/Downloads/trustance-admin-toggles-telegram-auth-email-events-full-implementation-v2.md`
**Architecture:** Existing legacy Telegram verifier/session, Settings table, durable notification outbox and SMTP transport remain the foundations. Reuse Radix Switch and email renderers. No dependencies or schema removals.

## Tasks

- [x] GPT-6.1 Sol high (melanjutkan implementasi awal Astra): regression-first Telegram fragment adapter, POST server verification, cookie intent and replay guard; preserve lookup-only account policy. Test existing auth and new negative cases.
- [x] GPT-6.1 Sol high (melanjutkan implementasi awal Astra): regressions for actual SMTP acceptance, remove EMAIL fake SENT shortcuts, bounded retries, registered/guest/no-recipient completion, actual admin test-email send and read-only diagnostics. Run focused tests/package typechecks.
- [x] Parent: core registry of 23 specified events plus compatible legacy extensions; tested db policy with optional boolean overrides, legacy defaults and mandatory reset. Integrate policy at enqueue and dispatch without resetting settings.
- [x] Parent: source copy for existing paid-order/reset templates, remove manual copy UI after cutover, retain stored legacy settings. Test renderer escaping, reset contract and links.
- [x] Parent: shared SettingsToggle from existing Switch; generic Settings boolean FieldRow with rollback/server refresh; convert actual boolean checkbox/radio only. UI regression tests, typecheck and focused Doctor.
- [x] Parent: email event rows and diagnostics in existing Settings, ON/OFF, audience, mandatory/config health separate. Test save error/boolean payload/readiness.
- [ ] Integration: sync own branch with latest master; full typecheck and tests once, lint, doctor:changed/bugs/full (0 errors, 0 warnings), production build and runtime smoke. Record commands/results and final review.

## Review focus

Telegram callback state remains bound to the initiating browser; unknown users keep existing signup policy. Replay must fail across requests. OFF at dispatch cannot become SENT. Buyer receipt never contains delivered credentials. Received vs paid event names cannot assert incorrect business facts. Default/inherited boolean values must match runtime. Historical data is read-only and production delivery cannot be inferred from local tests.

## Ledger

Audit completed before product edits. Main checkout contains unrelated untracked `skills-lock.json`; do not modify or remove it.

V2: seluruh 23 producers/prerequisites dibuat dan diuji; report akhir di docs/TRUSTANCE_AUTH_EMAIL_TOGGLES_REPORT.md. Full gate tetap pending sampai output aktual direkam.
