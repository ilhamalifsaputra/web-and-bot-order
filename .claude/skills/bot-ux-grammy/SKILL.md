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

## No leaked English

Customer- and admin-facing strings go through `t(ctx, key, args)` against `packages/core/locales/{en,id}.json`. When adding or changing a key:
- Add it to both `en.json` and `id.json` — the key sets must stay identical.
- Keep `{placeholders}` matched per key across both files.
