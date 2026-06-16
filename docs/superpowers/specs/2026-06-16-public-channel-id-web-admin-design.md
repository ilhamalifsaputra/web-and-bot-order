# Public channel ID editable in web admin — design

**Date:** 2026-06-16
**Status:** Approved (brainstorming)

## Problem

The notifier (testimoni → public Telegram channel) needs `PUBLIC_CHANNEL_ID`.
Today that value lives **only** in `.env` (`config.PUBLIC_CHANNEL_ID`, a
`z.coerce.number().optional()`), so the notifier refuses to start until someone
hand-edits the file:

```
Error: PUBLIC_CHANNEL_ID is required for the notifier  (apps/notifier/src/main.ts:14)
```

The matching credential `notif_bot_token` is *already* editable in web admin
(Settings → Bot & notifications, "Setting wins, env fallback"). The channel ID
is the other half of notifier setup and should live in the same place. "Untuk
setup bot, selain token pasti butuh id" — the admin sets up the bot by token +
channel together, both in the web UI.

A second friction point: admins think in terms of `t.me/xxx` / `@xxx` links, not
the numeric `-100…` ID the code requires. The earlier session input was literally
`t.me/testiilha`, which `getChat` resolves to `-1003960444894`.

## Goal

Make `public_channel_id` a web-admin Setting, mirroring `notif_bot_token`
exactly: **Setting wins when filled, env is the bootstrap/recovery fallback.**
Accept a username/link/numeric input and store the resolved numeric ID.

Non-goals: changing how notifications are queued/rendered; multi-channel support;
editing the channel from the Telegram bot.

## Decisions (from brainstorming)

- **Input format:** accept `t.me/xxx`, `@xxx`, a full `https://t.me/xxx` link, or
  a numeric `-100…`. Web admin resolves via Telegram `getChat` at save time and
  **stores the numeric ID**. (Chosen over "numeric only" — matches how admins
  actually have the channel handle.)
- **Access:** owner-only (`role === "super"`), same as the bot-token fields.
- **Apply:** restart to apply, consistent with the existing token messaging.
- **Not a secret:** channel IDs/handles are public — the value is shown in the
  form and the "all settings" table (unlike tokens).

## Architecture

Three layers, each copying the established `notif_bot_token` path.

### 1. Resolution (`packages/db/src/crud/credentials.ts`)

- Add `export const PUBLIC_CHANNEL_ID_KEY = "public_channel_id"`.
- Add `publicChannelId: number | null` to `ResolvedBotCredentials`.
- In `resolveBotCredentials`, read the Setting, parse to a finite number; fall
  back to `config.PUBLIC_CHANNEL_ID`; `null` when blank/invalid.

```ts
const parseChannelId = (v: string | null | undefined): number | null => {
  const s = orNull(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
// in resolveBotCredentials:
publicChannelId: parseChannelId(channel) ?? (config.PUBLIC_CHANNEL_ID ?? null),
```

### 2. Runtime stamp (`packages/core/src/runtime.ts`)

Add `publicChannelId` to `Resolved` + the `setBotIdentity` input, and a getter:

```ts
export function publicChannelId(): number | undefined {
  return resolved.publicChannelId ?? config.PUBLIC_CHANNEL_ID;
}
```

(`setBotIdentity` keeps merging fields, so passing `publicChannelId` is additive.)

### 3. Consumers stop reading `config.PUBLIC_CHANNEL_ID` directly

- **`apps/server/src/index.ts`** (composition root): stamp
  `publicChannelId: creds.publicChannelId ?? undefined` in the boot
  `setBotIdentity(...)` call; `startNotifier` reads the runtime getter for the
  "disabled when unset" guard and the startup log.
- **`apps/notifier/src/main.ts`** (standalone): resolve via
  `resolveBotCredentials(prisma)`; the `=== undefined` guard and log use the
  resolved value instead of `config.PUBLIC_CHANNEL_ID`.
- **`apps/notifier/src/dispatcher.ts`** lines 78 & 97: use the runtime getter
  `publicChannelId()` for the channel target and the 403 log. Reading it live
  means an already-running dispatcher picks up a changed ID next tick; turning
  the notifier on from a cold "no channel" boot still needs the restart (the
  guard ran once).

### 4. Web admin field (`apps/web-admin/src/routes/settings.ts`)

- Add to `EDITABLE`:
  `public_channel_id: "Public channel for announcements — paste the channel link (t.me/…), @username, or numeric -100… ID; saved as the numeric ID. Restart the app after saving."`
- Add `public_channel_id` to `BOT_TOKEN_FIELD_KEYS` so it renders in the
  Bot & notifications tab next to the notifier token. Rename nothing else.
- **Do NOT** add to `SECRET_KEYS` (public value, echoed back into the form).
- New branch in `POST /settings/edit`, evaluated before the generic write
  (sibling to the `TOKEN_KEYS` branch):
  1. Owner gate — non-`super` → "Only the owner can change the channel."
  2. `-` escape hatch → `deleteSetting`, audit `setting_clear`, env fallback
     returns after restart.
  3. Otherwise call `resolveChannelId(value)` (below). On failure → reject,
     nothing saved ("Couldn't find that channel…check the link and that the bot
     is a member/admin"). On success → `setSetting(prisma, "public_channel_id",
     String(id))`, audit `setting_set` with the resolved id (not secret), flash
     "Channel saved (resolved to <id>). Restart the app to apply."

### 5. Channel resolver (`apps/web-admin/src/lib/telegramCheck.ts`)

Add an injectable resolver beside the token validator:

```ts
export type ChannelCheck = { ok: boolean; id?: number; title?: string };

export async function checkChannelWithTelegram(
  botToken: string, input: string,
): Promise<ChannelCheck> {
  const chat = normalizeChannelInput(input); // strip https://, t.me/, leading @; keep -100… as-is
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chat)}`,
    );
    const data = await res.json() as { ok?: boolean; result?: { id?: number; title?: string } };
    return data.ok && typeof data.result?.id === "number"
      ? { ok: true, id: data.result.id, title: data.result.title }
      : { ok: false };
  } catch { return { ok: false }; }
}
```

- `normalizeChannelInput`: `https://t.me/foo` / `t.me/foo` / `@foo` → `@foo`;
  bare `-100…` or numeric → unchanged; trims whitespace.
- Injectable via `setChannelValidator` / `getChannelValidator` (same shape as the
  token validator) so route tests never hit the network.
- The bot token for `getChat` comes from `resolveBotCredentials`: notif token if
  set, else main token. If neither is configured the route rejects with "Set a
  bot token first, then add the channel."

## Data flow

```
admin types "t.me/testiilha"  ─POST /settings/edit─▶ owner gate ─▶ resolveChannelId
        ▼ getChat (notif|main token)
   { ok, id: -1003960444894 }  ─▶ setSetting("public_channel_id","-1003960444894") + audit
                                                              │ (restart)
   resolveBotCredentials ─▶ publicChannelId = -1003960444894 ─▶ setBotIdentity
                                                              ▼
   notifier guard passes ─▶ dispatcher posts to publicChannelId()
```

## Error handling

- Invalid/unreachable channel, or `getChat` returns `ok:false` → reject, save
  nothing (parity with the token getMe check).
- No bot token configured → reject with guidance to set the token first.
- Non-`super` admin → reject (owner gate), no DB write.
- `-` → clear Setting, env fallback after restart.
- Blank submit → "left unchanged" (no write), matching the generic edit path.
- Stored value that fails to parse to a number → treated as unset by
  `resolveBotCredentials` (env fallback / notifier disabled), never a crash.

## Testing

- **crud unit** (`packages/db`): `resolveBotCredentials` returns the parsed
  channel from Setting; falls back to `config.PUBLIC_CHANNEL_ID`; returns null on
  blank/garbage. Cover `parseChannelId`.
- **web route trio** (`apps/web-admin`): `POST /settings/edit` for
  `public_channel_id` — happy path (owner + stubbed `setChannelValidator`
  resolving to an id, asserts `setSetting` called with the numeric string +
  audit), auth-fail (non-owner rejected, no write), bad-csrf (rejected). Plus:
  invalid channel rejected, `-` clears, no-token rejected.
- **normalizeChannelInput** unit: link/@/numeric variants.
- `pnpm -r typecheck` and `pnpm test` stay green.

## Files touched

- `packages/db/src/crud/credentials.ts` — key, resolver field, parse helper
- `packages/core/src/runtime.ts` — `publicChannelId` stamp + getter
- `apps/server/src/index.ts` — stamp at boot, guard/log via getter
- `apps/notifier/src/main.ts` — resolve via credentials, guard/log
- `apps/notifier/src/dispatcher.ts` — getter at lines 78, 97
- `apps/web-admin/src/routes/settings.ts` — EDITABLE entry, group, edit branch
- `apps/web-admin/src/lib/telegramCheck.ts` — channel resolver + injection
- `.env` / `.env.example` — comment: now settable in web admin
- tests as above
