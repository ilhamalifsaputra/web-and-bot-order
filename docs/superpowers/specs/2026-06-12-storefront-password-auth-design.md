# Storefront Auth: Username+Password Login, Web Registration, Forgot Password, Telegram Linking

**Date:** 2026-06-12
**Status:** Approved by user
**Scope:** `apps/storefront`, `packages/db`, `packages/core`, `prisma/schema.prisma`, `apps/notifier` (admin-notif copy only). The bot's behavior does not change.

## Goal

Replace "Telegram Login Widget is the only way in" with a conventional
username+password auth as the primary method. The Telegram button stays on
/login but only signs in accounts that already have a linked `telegramId`
(every existing bot member qualifies automatically). New visitors register on
the web with username + email + password. Forgot-password works via email.
Members can link their Telegram account from a new settings page.

## Decisions (confirmed with user)

1. **Web registration is allowed** — accounts can exist with no Telegram at
   all. Admin order notifications via the bot still fire for these users,
   marked "via Website"; customer-side Telegram notifications are skipped
   until the user links Telegram.
2. **Password reset via email** (SMTP / nodemailer). Registration therefore
   requires a unique email.
3. **Bot members count as linked** — anyone who ever did /start can use the
   Telegram button on the web immediately. The widget no longer auto-creates
   accounts; unknown Telegram IDs get an error directing them to /register or
   the bot.
4. No unlink-Telegram feature (deliberately out of scope).

## 1. Schema changes (additive, nullable — safe for the shared SQLite DB)

- `users.telegram_id` → **nullable** (stays unique). Web-only users have NULL.
- New `users` columns:
  - `login_username` TEXT, unique, nullable — the web login handle.
    Rules: 3–32 chars, `[a-z0-9_]`, stored lowercase. Distinct from the
    existing `username` column (= Telegram username, untouched, bot-owned).
  - `email` TEXT, unique, nullable — required for web registration; bot-only
    members have NULL until they fill it in settings.
  - `password_hash` TEXT, nullable — bcrypt (bcryptjs, same as web-admin).
- New table `password_reset_tokens`:
  `id, user_id (FK users, cascade), token_hash (unique), expires_at, used_at, created_at`.
  Only the SHA-256 hash of the token is stored; expiry 1 hour; single-use.
- Deploy rule (CLAUDE.md): `pnpm prisma db push` against the live DB and
  restart order-bot **before** new code runs.

## 2. Login flow (`/login` reworked)

- Primary form: identifier (login_username OR email) + password → bcrypt
  verify → mint session. Generic "wrong username or password" on any failure
  (no enumeration). Banned users rejected like today.
- Telegram button below the form: verify HMAC exactly as today, then look up
  `getUserByTelegramId`. Found → log in. Not found → error message "this
  Telegram account isn't registered yet — register on the web or /start the
  bot". **No upsert from the widget anymore.**
- Guest-cart merge on successful login stays (both paths).

## 3. Web registration (`/register`, new)

- Fields: login username, email, password + confirmation. Honors `?ref=CODE`
  referral attribution exactly like the current widget flow (and `?next=`).
- Creates a user: `telegramId = null`, generated `referralCode`, role
  CUSTOMER, default language; merges guest cart; logs straight in.
- Validation: username format rule above; email syntax check; password min
  8 chars; uniqueness errors surfaced per-field.

## 4. Forgot password (`/forgot`, `/reset/:token`, new)

- `/forgot`: email input. Always renders "if that email is registered, a
  reset link was sent" (anti-enumeration). If the email matches a user,
  create a reset token row and send the link via SMTP.
- Mailer: nodemailer in `@app/core`, config keys `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. If SMTP is not configured the
  /forgot page says password reset is unavailable (and logs a warning).
- `/reset/:token`: new-password form. Token is hashed and matched, must be
  unused and unexpired; on success set `password_hash`, mark token used,
  rotate the user's session jti (logs out all existing sessions).

## 5. Member settings (`/account/settings`, new; linked from /account)

- Set/change login username, email, password. Existing bot members who signed
  in with Telegram create their password here. Changing the password requires
  the current password when one is already set.
- **Link Telegram**: the Telegram Login Widget rendered on the settings page
  with an auth URL of `/account/settings/link-telegram`. Verify HMAC → attach
  `telegramId` (+ refresh Telegram `username`/`fullName`) to the logged-in
  account. Rejected with a clear error if that telegramId already belongs to
  another account. Once linked, Telegram notifications work for this user.

## 6. Session & system adjustments

- `CustomerSession` re-keyed on `userId`: jti settings key becomes
  `shop_session_jti_user:<userId>` (was `shop_session_jti:<telegramId>`).
  One-time consequence at deploy: every active storefront session is logged
  out. The session payload keeps `telegramId` only as an optional field.
- Notifier/outbox: customer-facing events are sent only when the user has a
  `telegramId`; web-only customers see status on the web. Admin order
  notifications for web-only buyers carry a "via Website" marker.
- Bot unchanged: `upsertUser` on /start still auto-creates; it must keep
  working when the row it finds has `login_username`/`email` set (it never
  touches those columns).
- Locales: new keys in `packages/core/locales/{en,id}.json` for register,
  forgot/reset, settings, link-Telegram, and all error messages; key sets
  stay identical between the two files.

## 7. Security requirements

- bcrypt for passwords; SHA-256 for reset-token storage; timing-safe compares
  where strings are compared to secrets.
- No enumeration: login errors are generic; /forgot always claims success.
- CSRF (`csrfProtect`) on every new mutating route; reset/forgot/register are
  anonymous POSTs and get their own CSRF-exempt-but-rate-limited treatment
  consistent with how /auth/telegram (anonymous GET) is handled today —
  concretely: registration/forgot/reset forms carry no session CSRF (no
  session yet) and rely on SameSite=Lax cookies plus POST-only semantics.
- Never log passwords, hashes, or reset tokens (CLAUDE.md "never log
  secrets").

## 8. Testing

- CRUD unit tests: password set/verify, findUserByLoginUsername/email,
  createPasswordReset + consume (expiry, single-use), linkTelegram (success,
  conflict), web-registration create (referral attribution, unique
  collisions).
- Route tests in `apps/storefront/test`: happy/auth-fail/bad-csrf trio for
  every new mutating route; login (password ok / wrong / banned), Telegram
  login (known id / unknown id), register (dupes), forgot (existing /
  non-existing email render identically), reset (valid / expired / reused
  token), settings (password change wrong current password), link-telegram
  (conflict).
- `pnpm -r typecheck` and `pnpm test` stay green.
