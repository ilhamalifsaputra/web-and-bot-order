---
name: bot-ux-grammy
description: Use when editing apps/order-bot handlers or keyboards, or any grammY callback/message flow, before writing the code
---

# Bot UX (grammY)

## Overview

The Telegram bot's UX contract is: one live bubble per conversation thread, always editable, never stranding the user. Every rule below exists to keep a chat from accumulating dead buttons, duplicate confirmations, or English leaking into a localized product.

## When to Use

- Adding or editing a callback-query handler, message handler, or keyboard in `apps/order-bot/src/handlers/*` or `apps/order-bot/src/keyboards/*`.
- Adding a new terminal screen, confirmation, or multi-step (wizard) flow to the bot.
- Adding or changing any user-facing string in the bot.
- Adding or changing any inline-keyboard button label, especially catalog/picker buttons built from product or denomination names (see "Inline keyboard button labels").

## Edit the bubble, don't just toast

Every terminal button tap ends on `smartEdit` (customer) / `adminEdit` (admin) plus a navigation keyboard, turning the screen it lived on into a confirmation. Both helpers edit text *and* photo+caption bubbles, and fall back to a fresh send when an edit isn't possible. Never leave a stale screen behind — if a flow ends without calling one of these, that's a bug.

## One active keyboard per chat

Every render helper retires the previous bubble's inline keyboard (`retireKeyboard`) when a new screen appears elsewhere in the chat, so stale menus can't be tapped against moved-on state. Unknown or pre-migration callback data must answer with the `error.stale_screen` toast rather than silently failing or crashing.

## Wizards are single-bubble

Multi-step flows edit one anchor bubble (`adminAnchor`/`menuAnchor` for typed-input steps) and delete the user's typed input (`consumeInput`) once captured — prompts, validation errors, and the final confirmation all land in the same bubble, each with a live Cancel/Back keyboard.

Exception: customer free-text with record value (support text, review comments, TxIDs) and photos whose `file_id` is stored are NOT deleted — those are the data, not scratch input.

## Toast vs alert

- Routine success → non-blocking toast: `answerCallbackQuery({ text })`.
- Errors and destructive confirmations → `show_alert: true`.
- Slow terminal mutations render a buttonless `admin.processing` state first so a double-tap can't re-run them.

## Never strand the user

Every terminal screen offers at least one forward action (Menu / My Orders / Back). If you're adding a new terminal screen, check it against this before considering it done.

## Inline keyboard button labels (width, icons, fallback)

Telegram clients truncate a button by pixels, not characters: a full-width bold button shows roughly 28-34 characters on a phone (50+ on desktop). Labels that overflow get cut mid-word or fall back to a bare `#123`, which the user cannot read. These rules keep every button readable and distinguishable. They apply to buttons built from product/denomination/category names (the catalog and pickers in `apps/order-bot/src/util/canonicalPresenter.ts` and `keyboards/customer.ts`).

1. **Limits are named constants, never magic numbers.** They live in ONE module, `packages/core/src/buttonLimits.ts` (`canonicalPresenter.ts` re-exports them): `MAX_LABEL_WIDTH` (single-column hard cap, 36 cells), `TARGET_LABEL_WIDTH` (soft target the shortening steps aim for, 32), `NARROW_LABEL_WIDTH` (two buttons per row only at or under this, 18), `MAX_LABEL_BYTES` (64), `CATALOG_PAGE_SIZE` (products per page, 20, same for every game), `LIST_LABEL_MAX_CHARS` (30, the `truncLabel` cut on search/popular/category buttons), `PLAN_LABEL_MAX_CHARS` (24, the `truncLabel` cut on the Premium plan picker, which `util/format.ts` reads as `BUTTON_LABEL_MAX`; a plan label's admin budget is `NARROW_LABEL_WIDTH` so two buttons fit side by side). Width is measured in grapheme cells with `visualWidth` (emoji and CJK count as 2) — never `string.length`. `buttonNameBudget(kind)` derives how many cells an admin-typed name may use per kind of button; the admin panel shows it beside those fields (`ButtonLabelInput`, soft limit, hint + live counter) and the bot's admin prompts repeat it (`admin.button_hint_*`). Change a limit only in `buttonLimits.ts`, then copy that file over `apps/web-admin/client/src/lib/buttonLimits.ts` (the admin client cannot import `@app/core`; `packages/core/src/buttonLimits.test.ts` fails on drift) and update the guard tests. A new field whose text reaches a button gets a `ButtonNameKind` and a `ButtonLabelInput`.
2. **Compose a label from semantic data, never by gluing raw supplier names.** A label must not repeat a word (`Primogems Primogems 160`), repeat the unit or quantity (`1000 VP 1.000 VP`), or repeat the game/product name the intro already shows. Quantities are exact: `1186+224`, `10K` only for a clean multiple of 1000 from 10000 (never `1186 -> 1.2K`).
3. **Icons and abbreviations come only from the dictionary** `packages/core/src/unitDictionary.ts` (`UNITS`, `ABBREVIATIONS`; lookups in `unitDisplay.ts`). Never put an emoji or a hand-made abbreviation in a handler or keyboard builder. To support a new unit or word, add one line to the dictionary (its header explains the matching rules) and the dictionary tests will check it. Do not add a unit only because it looks like another one (Tokens/Credits/Points are not Coins). Different units that share an icon are spelled out when they meet in one list. An icon is presentation only: it never changes identity, callbacks, SKUs or prices.
4. **When a label does not fit, use the fallback chain, in order, stopping at the first step that fits AND stays unique in the list:** compact/icon form, full form, name-only, the amount's own unit as its icon (one phrase, never another word, and never for a unit that is spelled out in that list), abbreviations, a unit word the amount's head already states dropped from the name's start or end (`7 💎 Event Gift Pack 1`, not `... 1 Diamonds`), a trailing `- Garena` / `(Global)` dropped when it is the product's qualifier or the list repeats it, the first words plus the end behind one `…` (`Blessing of… Moon x2`), the end alone behind `…`, and only then the bare `#id`. A candidate that repeats a word, or repeats or places two dictionary icons side by side, is never accepted. Any shortened or `#id` button must be explained in the message body of the same page with the full name and exact price. Never leave two buttons that look identical.
5. **Callback identity is stable:** `v1:browse:denom:<id>` (at most 64 UTF-8 bytes), never derived from the label, price or page index.
6. **Row layout:** product rows first, then Previous/Next, Refresh and Back, each on its own row. The reply keyboard (digits 1-5 and the Menu button) is never changed or hidden by catalog work.
7. **Premium Apps (every category whose group is not `GAME_TOPUP`, including a null group) keep their original picker** — `denominationPickerKb` with `formatDenominationLabel` buttons and `browse.denomination_line` body lines (plan, price, stock), no `#id`. Do not route them through the canonical presenter, and gate any new canonical naming rule in `packages/core/src/canonicalProduct.ts` on `category.group === "GAME_TOPUP"`. (A CapCut Pro screenshot on 2026-10-01 showed what happens otherwise.)
8. **Tests are the guard.** Any label change must keep `apps/order-bot/test/keyboard-label-guard.test.ts` (hostile matrix, including SKUs with structured quantity and unit: every button within the shared limits, unique per page, explained when shortened, rows in order, no repeated word or icon, no shortened label that reads like another SKU; the Premium plan picker and the category/search/popular/variant/region pickers against their own limits; and no dictionary icon or abbreviation spelled in a keyboard builder, handler or the presenter), `apps/order-bot/test/canonical-presenter.test.ts` and `packages/core/src/unitDictionary.test.ts` green. When you add behavior, add hostile fixtures: very long names, CJK/emoji, `<` `&` `>`, dot-grouped numbers, names that only differ by price, and a list that mixes units sharing an icon.

## No leaked English

Customer- and admin-facing strings go through `t(ctx, key, args)` against `packages/core/locales/{en,id}.json`. When adding or changing a key:
- Add it to both `en.json` and `id.json` — the key sets must stay identical.
- Keep `{placeholders}` matched per key across both files.
