# Public Channel ID Editable in Web Admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the notifier's `public_channel_id` a web-admin Setting (paste a `t.me/…` link, `@username`, or numeric `-100…` ID — stored as the resolved numeric ID), mirroring how `notif_bot_token` already works: Setting wins, env is the fallback.

**Architecture:** A resolution layer in `packages/db` parses the Setting (or env fallback) into `ResolvedBotCredentials.publicChannelId`; `packages/core/runtime` stamps it for synchronous consumers; the three notifier consumers stop reading `config.PUBLIC_CHANNEL_ID` directly; the web-admin Settings route gains an owner-only field that resolves the input via Telegram `getChat` before saving.

**Tech Stack:** TypeScript, Fastify, Prisma/SQLite, grammY, Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-06-16-public-channel-id-web-admin-design.md`

---

## File Structure

- `packages/db/src/crud/credentials.ts` — add `PUBLIC_CHANNEL_ID_KEY`, `parseChannelId`, and `publicChannelId` field on `ResolvedBotCredentials`.
- `packages/db/src/crud/credentials.test.ts` — **new** crud unit test (no existing test for this module).
- `packages/core/src/runtime.ts` — add `publicChannelId` to `Resolved` + `setBotIdentity` input + a `publicChannelId()` getter.
- `packages/core/src/runtime.test.ts` — extend with a channel-id stamp test.
- `apps/web-admin/src/lib/telegramCheck.ts` — add `normalizeChannelInput`, `checkChannelWithTelegram`, and `setChannelValidator`/`getChannelValidator` injection hooks.
- `apps/web-admin/src/lib/telegramCheck.test.ts` — **new** unit test for `normalizeChannelInput`.
- `apps/web-admin/src/routes/settings.ts` — add `public_channel_id` to `EDITABLE` + `BOT_TOKEN_FIELD_KEYS`, a resolve-and-save branch, and re-export `setChannelValidator`.
- `apps/web-admin/test/web.test.ts` — extend the bot-tokens describe block with channel-id route tests.
- `apps/server/src/index.ts` — stamp `publicChannelId` at boot; guard/log via the runtime getter.
- `apps/notifier/src/main.ts` — resolve via `resolveBotCredentials`; guard/log via the resolved value.
- `apps/notifier/src/dispatcher.ts` — read `publicChannelId()` at the two `config.PUBLIC_CHANNEL_ID` sites.
- `.env` / `.env.example` — comment update pointing at the web-admin field.

---

## Task 1: Resolution layer in credentials.ts

**Files:**
- Modify: `packages/db/src/crud/credentials.ts`
- Test: `packages/db/src/crud/credentials.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/crud/credentials.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@app/core/config", () => ({
  config: { BOT_TOKEN: undefined, BOT_USERNAME: undefined, NOTIF_BOT_TOKEN: undefined, PUBLIC_CHANNEL_ID: -100999 },
}));

import { resolveBotCredentials } from "./credentials";
import type { Db } from "./_types";

/** In-memory Setting store as a Db stub (only `setting.findUnique` is used). */
function stubDb(values: Record<string, string>): Db {
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values[where.key] != null ? { key: where.key, value: values[where.key] } : null,
    },
  } as unknown as Db;
}

describe("resolveBotCredentials publicChannelId", () => {
  it("parses the numeric Setting (Setting wins over env)", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "-1003960444894" }));
    expect(creds.publicChannelId).toBe(-1003960444894);
  });

  it("falls back to env config.PUBLIC_CHANNEL_ID when the Setting is blank", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "  " }));
    expect(creds.publicChannelId).toBe(-100999);
  });

  it("falls back to env when the Setting is non-numeric garbage", async () => {
    const creds = await resolveBotCredentials(stubDb({ public_channel_id: "@notanumber" }));
    expect(creds.publicChannelId).toBe(-100999);
  });

  it("uses env (no crash) when the Setting row is absent entirely", async () => {
    const creds = await resolveBotCredentials(stubDb({}));
    expect(creds.publicChannelId).toBe(-100999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/db/src/crud/credentials.test.ts`
Expected: FAIL — `creds.publicChannelId` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement the resolver field**

In `packages/db/src/crud/credentials.ts`:

Add the key constant after line 15 (`export const NOTIF_BOT_TOKEN_KEY = "notif_bot_token";`):

```ts
export const PUBLIC_CHANNEL_ID_KEY = "public_channel_id";
```

Add a parse helper after the `orNull` definition (after line 18):

```ts
/** Parse a stored channel id to a finite number; null when blank/non-numeric. */
const parseChannelId = (v: string | null | undefined): number | null => {
  const s = orNull(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
```

Add the field to the `ResolvedBotCredentials` interface (after `notifBotToken` at line 26):

```ts
  /** Public channel id for announcements; null = notifier disabled. */
  publicChannelId: number | null;
```

Update `resolveBotCredentials` to read and return it:

```ts
export async function resolveBotCredentials(db: Db): Promise<ResolvedBotCredentials> {
  const [token, username, notifToken, channelId] = await Promise.all([
    getSetting(db, BOT_TOKEN_KEY),
    getSetting(db, BOT_USERNAME_KEY),
    getSetting(db, NOTIF_BOT_TOKEN_KEY),
    getSetting(db, PUBLIC_CHANNEL_ID_KEY),
  ]);
  return {
    botToken: orNull(token) ?? orNull(config.BOT_TOKEN),
    botUsername: orNull(username) ?? orNull(config.BOT_USERNAME),
    notifBotToken: orNull(notifToken) ?? orNull(config.NOTIF_BOT_TOKEN),
    publicChannelId: parseChannelId(channelId) ?? (config.PUBLIC_CHANNEL_ID ?? null),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/db/src/crud/credentials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/crud/credentials.ts packages/db/src/crud/credentials.test.ts
git commit -m "feat(db): resolve public_channel_id (Setting wins, env fallback)"
```

---

## Task 2: Runtime stamp + getter

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/src/runtime.test.ts:1-26`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/runtime.test.ts` (before the final line). Also add `publicChannelId` and `setBotIdentity` to the imports on line 2:

```ts
import {
  adminIds, isAdmin, setAdminIds, addAdminId, resetBotIdentity,
  webCookieSecret, setWebSecret, setBotIdentity, publicChannelId,
} from "./runtime";
```

New describe block at the end:

```ts
describe("runtime public channel id", () => {
  it("returns the stamped channel id", () => {
    setBotIdentity({ publicChannelId: -1003960444894 });
    expect(publicChannelId()).toBe(-1003960444894);
  });
  it("is undefined when nothing is stamped and env is unset", () => {
    expect(publicChannelId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/runtime.test.ts`
Expected: FAIL — `publicChannelId` is not exported / not a function.

- [ ] **Step 3: Implement the stamp + getter**

In `packages/core/src/runtime.ts`:

Add to the `Resolved` interface (after `notifBotToken?: string;` line 15):

```ts
  publicChannelId?: number;
```

Add to the `setBotIdentity` parameter type (after `notifBotToken?: string;` line 26):

```ts
  publicChannelId?: number;
```

Add the getter after `notifBotToken()` (after line 46):

```ts
export function publicChannelId(): number | undefined {
  return resolved.publicChannelId ?? config.PUBLIC_CHANNEL_ID;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/runtime.test.ts
git commit -m "feat(core): stamp publicChannelId in runtime identity"
```

---

## Task 3: Channel resolver in telegramCheck.ts

**Files:**
- Modify: `apps/web-admin/src/lib/telegramCheck.ts`
- Test: `apps/web-admin/src/lib/telegramCheck.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/web-admin/src/lib/telegramCheck.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeChannelInput } from "./telegramCheck";

describe("normalizeChannelInput", () => {
  it("strips a full https link to @username", () => {
    expect(normalizeChannelInput("https://t.me/testiilha")).toBe("@testiilha");
  });
  it("strips a bare t.me link to @username", () => {
    expect(normalizeChannelInput("t.me/testiilha")).toBe("@testiilha");
  });
  it("keeps an @username as-is", () => {
    expect(normalizeChannelInput("@testiilha")).toBe("@testiilha");
  });
  it("adds @ to a bare username", () => {
    expect(normalizeChannelInput("testiilha")).toBe("@testiilha");
  });
  it("passes a numeric -100 id through untouched", () => {
    expect(normalizeChannelInput("-1003960444894")).toBe("-1003960444894");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizeChannelInput("  @testiilha  ")).toBe("@testiilha");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web-admin/src/lib/telegramCheck.test.ts`
Expected: FAIL — `normalizeChannelInput` is not exported.

- [ ] **Step 3: Implement the resolver + injection hooks**

Append to `apps/web-admin/src/lib/telegramCheck.ts`:

```ts
export type ChannelCheck = { ok: boolean; id?: number; title?: string };

/**
 * Normalize admin input to a Telegram `chat_id` argument:
 * link / @username / bare username -> "@username"; a numeric (-100…) id is
 * passed through unchanged.
 */
export function normalizeChannelInput(input: string): string {
  let s = input.trim();
  if (/^-?\d+$/.test(s)) return s; // numeric id (e.g. -1003960444894)
  s = s.replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^@/, "");
  return `@${s}`;
}

/**
 * Resolve a channel input to its numeric id via getChat. Plain fetch (no grammy
 * here); the bot token never appears in logs or error messages.
 */
export async function checkChannelWithTelegram(botToken: string, input: string): Promise<ChannelCheck> {
  const chat = normalizeChannelInput(input);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chat)}`,
    );
    const data = (await res.json()) as { ok?: boolean; result?: { id?: number; title?: string } };
    return data.ok && typeof data.result?.id === "number"
      ? { ok: true, id: data.result.id, title: data.result.title }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

let channelValidator: (botToken: string, input: string) => Promise<ChannelCheck> = checkChannelWithTelegram;

/** Test hook: stub the getChat call so tests never hit the network. */
export function setChannelValidator(fn: typeof channelValidator): void {
  channelValidator = fn;
}

/** Current channel validator (the stub in tests, the real getChat otherwise). */
export function getChannelValidator(): typeof channelValidator {
  return channelValidator;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web-admin/src/lib/telegramCheck.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/lib/telegramCheck.ts apps/web-admin/src/lib/telegramCheck.test.ts
git commit -m "feat(web): channel-input normalizer + getChat resolver"
```

---

## Task 4: Web admin settings route — field + resolve-and-save branch

**Files:**
- Modify: `apps/web-admin/src/routes/settings.ts`
- Test: `apps/web-admin/test/web.test.ts:619-683` (extend the bot-tokens describe)

- [ ] **Step 1: Write the failing tests**

In `apps/web-admin/test/web.test.ts`, update the settings import on line 35 to also pull the channel validator:

```ts
import { setTokenValidator, setChannelValidator } from "../src/routes/settings";
```

Append these tests inside the existing `describe("settings: bot tokens (§16)", ...)` block (before its closing `});` at line 683):

```ts
  it("resolves a channel link to its numeric id and saves it", async () => {
    setTokenValidator(async () => ({ ok: true, username: "MyShopBot" }));
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue"); // a token must exist to resolve with
    setChannelValidator(async () => ({ ok: true, id: -1003960444894, title: "TESTIMONI" }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "t.me/testiilha",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "public_channel_id")).toBe("-1003960444894");
  });

  it("rejects an unresolvable channel — nothing is stored", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: false }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@nope",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("rejects when no bot token is configured to resolve with", async () => {
    await deleteSetting(prisma, "bot_token");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(res.headers.location).toContain("kind=error");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it("channel edits are owner-only (support role refused)", async () => {
    await setSetting(prisma, "bot_token", "123456:goodtokenvalue");
    setChannelValidator(async () => ({ ok: true, id: -100123, title: "x" }));
    await setSetting(prisma, webRoleKey(ADMIN_TG), "support");
    await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "@chan",
    });
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });

  it('a single "-" clears the saved channel id', async () => {
    await setSetting(prisma, "public_channel_id", "-1003960444894");
    const res = await post("/settings/edit", seed.cookie, {
      csrf_token: seed.csrf, key: "public_channel_id", value: "-",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toContain("kind=success");
    expect(await getSetting(prisma, "public_channel_id")).toBeNull();
  });
```

Note: `deleteSetting` must be in the test's `@app/db` import block (lines 39-45). If absent, add it there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts -t "channel"`
Expected: FAIL — `setChannelValidator` is not exported from the settings route; the route has no `public_channel_id` branch so saves go through the generic path (wrong) or the key is rejected as non-editable.

- [ ] **Step 3: Implement the route changes**

In `apps/web-admin/src/routes/settings.ts`:

Extend the import from `../lib/telegramCheck` (line 29) to include the channel hooks and the resolver:

```ts
import { setTokenValidator, getTokenValidator, setChannelValidator, getChannelValidator } from "../lib/telegramCheck";
```

Update the re-export line (line 32) so tests can import it:

```ts
export { setTokenValidator, setChannelValidator };
```

Also import the credentials resolver and the channel key — add to the existing `@app/db` import block (lines 8-16):

```ts
  resolveBotCredentials,
```

Add the `public_channel_id` entry to `EDITABLE` (after the `notif_bot_token` line 63):

```ts
  public_channel_id: "Public channel for announcements — paste the channel link (t.me/…), @username, or numeric -100… ID; saved as the numeric ID. Restart the app after saving.",
```

Add the key to the bot-setup group (line 76):

```ts
const BOT_TOKEN_FIELD_KEYS = new Set(["bot_token", "bot_username", "notif_bot_token", "public_channel_id"]);
```

Do **NOT** add it to `SECRET_KEYS` or `TOKEN_KEYS`.

In `POST /settings/edit`, add a dedicated branch immediately **after** the `TOKEN_KEYS` block closes (after line 319, before the generic `displayValue` write). The branch:

```ts
    // Channel id: owner-only, resolved via getChat before storing (numeric id).
    // Not a secret — the value is public and shown back in the form.
    if (key === "public_channel_id") {
      if (req.admin!.role !== "super") {
        return redirectWithFlash(reply, "/settings", "Only the owner can change the channel.", "error");
      }
      // Escape hatch: "-" removes the Setting so env config is used after restart.
      if (value === "-") {
        await deleteSetting(prisma, key);
        await logAdminAction(prisma, {
          adminId: req.admin!.userId, action: "setting_clear", targetType: "setting", details: key,
        });
        return redirectWithFlash(reply, "/settings", "Channel cleared. After a restart the server's own configuration is used again.", "success");
      }
      // getChat needs a bot token — notifier token if set, else the main token.
      const creds = await resolveBotCredentials(prisma);
      const botToken = creds.notifBotToken ?? creds.botToken;
      if (!botToken) {
        return redirectWithFlash(reply, "/settings", "Set a bot token first, then add the channel.", "error");
      }
      const check = await getChannelValidator()(botToken, value);
      if (!check.ok || typeof check.id !== "number") {
        return redirectWithFlash(reply, "/settings", "Couldn't find that channel. Check the link and that the bot is a member/admin of it.", "error");
      }
      await setSetting(prisma, key, String(check.id));
      await logAdminAction(prisma, {
        adminId: req.admin!.userId, action: "setting_set", targetType: "setting",
        details: `${key}=${check.id}`, // channel id is public, fine to log
      });
      return redirectWithFlash(reply, "/settings", `Channel saved (resolved to ${check.id}). Restart the app to apply.`, "success");
    }
```

(`getTokenValidator` stays imported/used by the existing token branch — keep it in the import list.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/web-admin/test/web.test.ts -t "channel"`
Expected: PASS (5 channel tests). Then run the whole file: `pnpm vitest run apps/web-admin/test/web.test.ts` — all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/settings.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web): edit public_channel_id in Settings (owner-only, getChat resolve)"
```

---

## Task 5: Switch consumers off config.PUBLIC_CHANNEL_ID

**Files:**
- Modify: `apps/server/src/index.ts:135-152,170-175`
- Modify: `apps/notifier/src/main.ts:6-30`
- Modify: `apps/notifier/src/dispatcher.ts:10-19,78,97`

No new test — covered by typecheck plus the existing notifier/server boot. Manual smoke at Task 7.

- [ ] **Step 1: dispatcher.ts — read the runtime getter**

In `apps/notifier/src/dispatcher.ts`, change the import on line 17 from:

```ts
import { config } from "@app/core/config";
```

to:

```ts
import { publicChannelId } from "@app/core/runtime";
```

(If `config` is used elsewhere in the file, keep the line and add a second import instead — verify with a search; as of now `config` is only used at lines 78 and 97.)

Line 78 — change:

```ts
    const chatId = isDm ? Number(payload.chat_id) : Number(config.PUBLIC_CHANNEL_ID);
```

to:

```ts
    const chatId = isDm ? Number(payload.chat_id) : Number(publicChannelId());
```

Line 97 — change:

```ts
          `Bot is not allowed to post in channel ${config.PUBLIC_CHANNEL_ID} — marking failed`,
```

to:

```ts
          `Bot is not allowed to post in channel ${publicChannelId()} — marking failed`,
```

- [ ] **Step 2: notifier/main.ts — resolve via credentials**

In `apps/notifier/src/main.ts`, the resolver is already imported (`resolveBotCredentials`). Resolve credentials before the guard and use the resolved channel id. Replace lines 12-32 (the body up to the `runDispatcher` call) with:

```ts
async function main(): Promise<void> {
  await initDb();
  setAdminIds(await resolveAdminIds(prisma));

  // Setting wins, env is the fallback (plan.md §16). Stamp the channel id so the
  // dispatcher's publicChannelId() getter sees it.
  const { notifBotToken, publicChannelId } = await resolveBotCredentials(prisma);
  if (publicChannelId === null) {
    throw new Error("public_channel_id is not set — add it in web admin (Settings → Bot & notifications) or PUBLIC_CHANNEL_ID in .env");
  }
  setBotIdentity({ publicChannelId });

  // The standalone notifier needs a dedicated token — it has no main bot instance.
  if (!notifBotToken) {
    throw new Error("notif_bot_token (Settings) or NOTIF_BOT_TOKEN env is required for the notifier");
  }

  const bot = new Bot(notifBotToken);
  const me = await bot.api.getMe();
  logger.info(
    `Notif bot started: @${me.username} -> channel ${publicChannelId} ` +
      `(poll every ${config.NOTIF_POLL_INTERVAL_SECONDS}s)`,
  );

  await runDispatcher(bot);
}
```

Update the imports at the top of the file: add `setBotIdentity` to the `@app/core/runtime` import (line 9 currently imports `setAdminIds`):

```ts
import { setAdminIds, setBotIdentity } from "@app/core/runtime";
```

`config` is still used for `NOTIF_POLL_INTERVAL_SECONDS`, so keep the `@app/core/config` import (line 7).

- [ ] **Step 3: server/index.ts — stamp at boot, guard via getter**

In `apps/server/src/index.ts`:

In the boot `setBotIdentity({...})` call (lines 171-175), add the channel id:

```ts
  setBotIdentity({
    botToken: creds.botToken ?? undefined,
    botUsername: creds.botUsername ?? undefined,
    notifBotToken: creds.notifBotToken ?? undefined,
    publicChannelId: creds.publicChannelId ?? undefined,
  });
```

In `startNotifier`, change the guard (line 135) and the log (line 151). Add `publicChannelId` to the `@app/core/runtime` import at the top of the file (it already imports `notifBotToken`, `setBotIdentity`, etc.). Replace the guard:

```ts
  if (config.PUBLIC_CHANNEL_ID === undefined) {
    logger.info("Notifier disabled (PUBLIC_CHANNEL_ID not set)");
    return;
  }
```

with:

```ts
  if (publicChannelId() === undefined) {
    logger.info("Notifier disabled (public_channel_id not set in Settings or env)");
    return;
  }
```

Replace the log line 151 reference `${config.PUBLIC_CHANNEL_ID}` with `${publicChannelId()}`.

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS — no references to `config.PUBLIC_CHANNEL_ID` remain in the three consumers (the field still exists on `config` for the env fallback inside `resolveBotCredentials` and the runtime getter, so the schema is unchanged).

Verify with: `grep -rn "config.PUBLIC_CHANNEL_ID" apps/` — expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add apps/notifier/src/dispatcher.ts apps/notifier/src/main.ts apps/server/src/index.ts
git commit -m "feat(notifier): read public_channel_id from Settings (env fallback)"
```

---

## Task 6: Env comments point at the web-admin field

**Files:**
- Modify: `.env:120-127`
- Modify: `.env.example:113-116`

- [ ] **Step 1: Update .env.example**

Replace lines 113-116 of `.env.example` with:

```
# PUBLIC_CHANNEL_ID & NOTIF_BOT_TOKEN are now editable in web admin
# (Settings → Bot & notifications). Set them there (paste a t.me/… link or
# @username for the channel — it's resolved to the numeric id). The values
# below are an optional bootstrap fallback used until the Settings rows exist.
# NOTIF_BOT_TOKEN=
# PUBLIC_CHANNEL_ID=-100...
```

- [ ] **Step 2: Update .env**

In `.env`, replace lines 123-125 (the `# Separate bot token...` / `# NOTIF_BOT_TOKEN=` / `# PUBLIC_CHANNEL_ID=-100...` comment trio) with:

```
# Set the notifier token + public channel in web admin (Settings → Bot &
# notifications). Paste a t.me/… link or @username for the channel; it's saved
# as the numeric id. These env lines are only a bootstrap fallback.
# NOTIF_BOT_TOKEN=
# PUBLIC_CHANNEL_ID=-100...
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): public_channel_id is set in web admin now"
```

(Note: `.env` is gitignored — only `.env.example` is committed. Edit `.env` for the live dev box but do not stage it.)

---

## Task 7: Full verification + manual smoke

- [ ] **Step 1: Typecheck + full test suite**

Run: `pnpm -r typecheck && pnpm test`
Expected: PASS — all green.

- [ ] **Step 2: Manual smoke in web admin**

Start the apps (web admin + storefront already wired): `pnpm dev:web`.
Log in as the owner, go to Settings → Bot & notifications. Confirm a **Public channel** field is present next to the notifier token, pre-filled if a value is saved.

- [ ] **Step 3: Save a channel and confirm resolution**

Ensure a bot token is configured (Settings). In the Public channel field, enter `t.me/<your-channel>` (or `@<channel>`), save. Expect a green flash "Channel saved (resolved to -100…). Restart the app to apply." Verify the stored Setting is numeric:

Run: `node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.setting.findUnique({where:{key:'public_channel_id'}}).then(r=>{console.log(r);return p.$disconnect()})"`
Expected: a row whose `value` is the numeric `-100…` id.

- [ ] **Step 4: Confirm the notifier picks it up**

Restart and start the notifier: `pnpm dev:notifier`.
Expected log: `Notif bot started: @<bot> -> channel -100… (poll every 10s)` — no more "PUBLIC_CHANNEL_ID is required" crash.

- [ ] **Step 5: Final commit if any tweaks were needed**

```bash
git add -A
git commit -m "chore: verify public_channel_id web-admin flow"
```

---

## Self-Review Notes

- **Spec coverage:** resolution layer (Task 1), runtime stamp (Task 2), resolver helper (Task 3), web field + owner gate + getChat + `-` clear + no-token reject (Task 4), three consumers (Task 5), env docs (Task 6), tests across Tasks 1/2/3/4 + manual smoke (Task 7). All spec sections mapped.
- **Type consistency:** `publicChannelId` is `number | null` on `ResolvedBotCredentials` (Task 1) and `number | undefined` from the runtime getter (Task 2); consumers convert `null`→`undefined` when stamping (Task 5 server) and guard on `=== null` (Task 5 notifier) / `=== undefined` (getter). `ChannelCheck.id` is `number`; the route stores `String(check.id)`; the resolver parses it back with `Number(...)`. `setChannelValidator` is defined in Task 3 and re-exported + used in Task 4.
- **No placeholders:** every code step shows full code; commands have expected output.
