# Placeholder copy register (§21.3)

> Every placeholder string awaiting real copy, tagged `TODO_COPY`, listed
> here so no placeholder ships silently (prompt §21.3).

---

## Status: **none**

No `TODO_COPY` placeholder was introduced anywhere in this redesign.
`grep -rn "TODO_COPY" apps/storefront/client/src` returns nothing.

### Why there are none

This redesign is a **re-skin of existing business content** (§2). Every
Fase 7 page migration carried a hard constraint to preserve the page's
existing `t("web.…")` i18n keys verbatim — no copy was written, reworded,
or invented. The migrations that *did* touch the locale files added keys
only for genuinely new UI affordances, all with real ID + EN strings (not
placeholders):

| Commit | New keys | For |
|---|---|---|
| `db898b82` (Task 5 chrome) | `web.nav_{home,search,cart,orders_tab,account,primary}` | mobile bottom tab bar labels |
| `a976a1f7` (Task 12 search overlay) | `web.search_no_results`, `web.search_browse_all`, `web.search_close` | search overlay empty/close affordances |
| `b4cd3267` (Task 8 state components) | `web.state_*` (×8) | ErrorState / NotFoundState / PermissionDeniedState / LoadingState default copy |
| `9868ecbb` (Task 14 PayPage) | cancel-order `AlertDialog` title/body/confirm/cancel | destructive-action confirmation dialog |
| `91198589` (Task 16 AccountPage) | logout `AlertDialog` title/body/confirm/cancel | destructive-action confirmation dialog |
| `903c0d4b` (Task 16 OrdersPage) | `web.orders_no_match` | "no orders match your filter" empty state (distinct from `web.no_orders`) |
| `9198d085` (Task 13 checkout) | payment-method group headings (×3) | grouped payment-rail section labels |

`packages/core/locales/en.json` and `id.json` are at **635 `web.*` keys
each** — exact parity, enforced by the repo's own locale-parity test
(`packages/core/src/locales.test.ts`), which stayed green throughout.

### Real copy that is shop-configured, not placeholder

Some strings render from `useShopContext()` (brand name, tagline, hero
image, WhatsApp/Telegram handles, regulator/company-entity disclosure).
These are intentionally blank until a shop operator fills them in via
web-admin Settings — they are **configuration**, not placeholder copy, and
every consuming component degrades gracefully when they are unset (e.g.
`AuthBrandPanel` and the footer omit an unconfigured contact channel
rather than showing a stub). This is pre-existing behavior the redesign
preserved, not something it introduced.

---

_Last reviewed: end of Fase 7 (all 32 routes migrated)._
