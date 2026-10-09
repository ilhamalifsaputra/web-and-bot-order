# Storefront: game top-up pages separate from Premium Apps

Date: 2026-10-09 · Status: approved design, awaiting spec review · Branch: `worktree-storefront-game-topup-pages` (worktree `.claude/worktrees/storefront-game-topup-pages`, rebased on master 804562b2)

## Intent
A buyer of a game top-up (category group `GAME_TOPUP`) must see pages built for a game top-up — before buying and after buying — not the Premium Apps template. Premium Apps pages stay exactly as they are.

What the owner said: "storefront informasi buy dan after buy top up game jangan sama template halamannya dengan premium apps". Decisions taken in the brainstorm:
1. Every product in a `GAME_TOPUP` category uses the game template before purchase, regardless of the category's `checkoutFlow` setting.
2. After purchase, the pay page and the order detail page stay the same two routes, but a game top-up gets its own "top-up detail" section and loses premium-only wording.

## Current state (master c922c3d3, still accurate at 804562b2)
- `/p/:slug` → `ProductPage`, which renders `InstantBuyPage` only when `product.checkout_flow === "instant"` (`apps/storefront/client/src/pages/ProductPage.tsx:~260`). A game top-up in a `catalog`-flow category therefore gets the Premium-style page (plan picker, stock, warranty, add to cart, reviews, no Game ID fields).
- After purchase there is one template for every type: `PayPage` (`/checkout/:code/pay`) then `OrderDetailPage` (`/account/orders/:code`). Only `presentation.titleKey/bodyKey` differ by `transactionType`. A game top-up today shows "View my credentials" (`web.view_credentials`), "Your credentials are ready in My orders." (`web.pay_done_sub`), a Warranty column (`web.warranty_days`), its SN inside the generic "Delivered content" card, and a retry/expired link to `/cart` although the top-up never used a cart.
- The `/api/v1/topup/*` endpoints (`apps/storefront/src/routes/apiTopup.ts`) are not gated on `checkoutFlow`: any active denomination can be bought through them (Digiflazz SKUs are limited to quantity 1).

## Design

### 1. Template choice is decided on the server
- `GET /api/v1/pages/product/:slug` (`apps/storefront/src/pageData.ts`) gains `template: "game" | "catalog"`:
  - `"game"` when the product's category `group === "GAME_TOPUP"`;
  - otherwise `"game"` when `checkoutFlow === "instant"` (keeps today's instant pilot working for any non-game category that opted in), else `"catalog"`.
- `ProductPage` switches on `product.template` instead of `checkout_flow`. The client never derives the type itself.
- `checkout_flow` stays in the payload for backward compatibility of any cached client, but no page branches on it any more.
- Admin (`apps/web-admin/client/src/components/catalog/CategoryDialog.tsx`): beside the checkout-flow control, a short hint that categories in the Game Top-Up group always use the top-up page. No behaviour change in admin.

### 2. Pre-purchase game template = the existing `InstantBuyPage`
- No new page: `InstantBuyPage` already is a game top-up page (account fields from `additional_fields`, nickname check, denomination grid, guest contact, payment method, summary, sticky bar, no cart).
- Consequence accepted: a manual (non-Digiflazz) game SKU that used to allow several units via the cart is now bought one unit per order.
- Product with no active denominations or an invalid input configuration: `InstantBuyPage`'s existing empty/invalid states apply.

### 3. Post-purchase: one game section, premium wording removed for games
Branch key: `presentation.transactionType === "GAME_TOPUP"` (already sent by `/orders/:code/pay`, `/status` and `/account/orders/:code`). Wallet top-up and Premium Apps are untouched.

- New component `GameTopupDetailCard` (`apps/storefront/client/src/components/shop/`), used by `PayPage` (when the order is delivered or processing) and `OrderDetailPage`. It shows only fields that exist:
  - product name and denomination (from the order items);
  - Game ID and Zone / Server ID — taken ONLY from the denomination's player-input mapping (`packages/core/src/playerInput.ts`: target, zone and server keys), never other `customerData` fields;
  - SN / reference: the decrypted Digiflazz SN in full, with a Copy button; shown only to the order's owner (same authorization that already gates `delivered_content`);
  - the existing Digiflazz status line (pending / reviewing / failed copy already in `web.digiflazz_*`).
- For a game top-up:
  - `OrderDetailPage` hides the Warranty column and the stock "Credentials" section, and does not render the generic "Delivered content" card (the SN lives in `GameTopupDetailCard`). The customer-input edit section (editable until dispatch) stays.
  - `PayPage` uses game wording: the delivered call-to-action reads "View top-up details" (new key) instead of `web.view_credentials`; the legacy delivered card uses a game sub-line instead of `web.pay_done_sub`.
  - Retry / expired / cancelled actions link back to the product page `/p/:slug`, not `/cart`.
- API additions (server only; no Telegram from the web):
  - `GET /api/v1/orders/:code/pay` and `GET /api/v1/account/orders/:code` add `product_slug` (first item's product slug) and, for `GAME_TOPUP` orders, `game_target: { game_id?: string; zone_id?: string; server_id?: string }` built through the mapping, and `sn?: string` (owner only, decrypted with `decryptDeliveredContent`; on decrypt failure the field is omitted and the error is logged by order code and error class only).
  - Guest orders reached via `/track` use the same owner check those routes already apply.
- i18n: new `web.*` keys in both `packages/core/locales/en.json` and `id.json` (identical key sets, natural Indonesian), e.g. `web.topup_detail_title`, `web.topup_game_id`, `web.topup_zone_id`, `web.topup_server_id`, `web.topup_sn`, `web.topup_sn_copy`, `web.view_topup_details`, `web.pay_done_sub_topup`. Reuse existing keys where an equivalent exists.

### 4. Out of scope
- Premium Apps pages, wallet top-up pay page, cart/checkout page for non-game products, the Telegram bot (handled on `worktree-telegram-clean-checkout`), new routes, SEO changes.

## Error handling
- Missing mapping or missing values: the corresponding line is omitted; the card never shows empty labels.
- SN not yet available (processing): the SN line is absent and the existing processing/progress UI stays.
- Decrypt failure: no SN line, no client error, server log without content.
- Non-owner request: no `sn` and no `game_target` (existing 403/404 behaviour unchanged).

## Testing
- Server (`apps/storefront/test/`): `pageData` returns `template: "game"` for a `GAME_TOPUP` category in `catalog` flow, `"catalog"` for Premium, `"game"` for an instant non-game category; pay/order endpoints return `product_slug`, `game_target` built only from mapped keys (a private extra field such as `password` never appears), full SN for the owner, no SN for a non-owner, no SN on decrypt failure.
- Client (`*.test.tsx`): `ProductPage` renders `InstantBuyPage` for `template: "game"` and the catalog page otherwise; `GameTopupDetailCard` shows Game ID / Zone / full long SN with copy and omits missing lines; `OrderDetailPage` for a game order has no warranty column, no credentials section, no generic delivered-content card; Premium order detail unchanged (regression); `PayPage` game wording and retry link to `/p/:slug`; Premium pay page unchanged.
- Admin: `CategoryDialog` hint renders.
- Gate: per task `pnpm test:changed` + package typecheck; once before merge `pnpm typecheck && pnpm test` after rebasing onto latest master.

## Constraints
Follow `AGENTS.md` (money as Decimal, no raw SQL in routes — DB reads through `packages/db/src/crud/*`, i18n in both locales, never log secrets, never send Telegram from the web) and the skills `web-fastify-conventions` and `ui-development-dispatch`. Note: `app.css` shorthands (`.field`/`.card`/`.btn`) beat Tailwind utilities at equal specificity.
