---
name: persistent-keyboard-i18n
description: How the order-bot persistent reply keyboard is built + matched in a language-aware way (after the L2 i18n fix)
metadata:
  type: project
---

Persistent reply-keyboard labels (the bottom `mainPersistentKb` / numbered `productsPersistentKb`) are localized as of 2026-05-31. All lives in `apps/order-bot/src/keyboards/customer.ts`.

Design (replaces the old hardcoded `BTN_*` string constants, which are GONE):
- `PersistentAction` union + `PERSISTENT_LABEL_KEYS` map each action → a locale key (browse→menu.browse, orders→menu.my_orders, wallet→menu.wallet, prev→browse.nav_prev, next→browse.nav_next, back→menu.back, main→menu.main, etc.).
- `persistentLabel(action, lang)` renders one label; builders take `lang` now (`mainPersistentKb(lang)`, `productsPersistentKb(count, lang, opts)`).
- `matchPersistentLabel(text): PersistentAction | null` resolves typed text back to an action by comparing against EVERY supported language's label set (MATCH_LANGS = en, id). This is what `handleProductNumber` (customer.ts) uses — a `switch(action)`, NOT literal `===` compares. So matching is language-agnostic; a number/free text returns null.
- `supportLabels()` returns the support label in all langs; `conversations/index.ts` uses `hears: supportLabels()` (array) so the support conversation entry in main.ts (`bot.hears`) fires regardless of UI language. `ConvSpec.hears` type widened to `string | string[]`.

Gotcha: support is entered ONLY via the conversation `hears` trigger (registered before the message:text handler), so `handleProductNumber`'s `case "support": return;` is a deliberate no-op fallthrough.

If you add a new persistent button: add to `PersistentAction` + `PERSISTENT_LABEL_KEYS` + the builder + a `case` in handleProductNumber. Matching comes for free via matchPersistentLabel.

See [[ux-antipatterns]] and [[shopping-flow-landmarks]].
