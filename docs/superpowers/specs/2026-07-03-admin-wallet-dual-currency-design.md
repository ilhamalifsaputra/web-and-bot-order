# Admin panel: split wallet balance into IDR and USDT

## Context

The bot request: "saldo wallet harus terbagi menjadi dua jenis, idr dan usdt"
(wallet balance must be split into two types, IDR and USDT).

Investigation found the dual-currency wallet is **already fully implemented**
at the data layer:

- `User.walletBalance` (IDR) and `User.walletBalanceUsdt` (USDT) are two
  independent balances (`prisma/schema.prisma`). There is no `walletCurrency`
  field — that concept was removed when the dual-balance design landed.
- `WalletTransaction.currency` tags each ledger row with which balance it
  moved; a user's ledger can and does contain both IDR and USDT rows.
- `adjustWallet` (`packages/db/src/crud/users.ts`) already accepts a
  `currency: "IDR" | "USDT"` option and debits/credits the matching balance
  independently, with no cross-currency conversion.
- The bot (`apps/order-bot/src/handlers/customer.ts`, `viewWallet`) and the
  storefront checkout (`apps/storefront/src/routes/checkout.ts`) already
  read and use both balances correctly.

The gap is entirely in the **admin panel's customer detail page**
(`apps/web-admin/client/src/pages/UserDetailPage.tsx`), which still has a
stale single-currency model:

- The `UserDetail.user` type declares a `walletCurrency: string` field that
  doesn't exist on the backend response — it renders as `undefined` at
  runtime.
- Only `user.walletBalance` (IDR) is ever displayed; `walletBalanceUsdt` is
  never shown.
- The wallet-adjustment form (amount + note) has no currency selector, so
  every admin adjustment silently targets IDR via `adjustWallet`'s default,
  even though the backend fully supports adjusting USDT.
- The wallet ledger table's TS type doesn't match `WalletLedgerEntry`'s real
  shape (`balanceAfter` not `balance`, has `currency`, has no `id`), and the
  rendered table has no currency column.

Scope, per user confirmation: **admin panel only**. Bot and storefront are
already correct and out of scope.

## Design

### 1. Backend — accept a currency on wallet adjustment

File: `apps/web-admin/src/routes/api/users.ts`, `POST /api/users/:userId/wallet`
(lines 85-117).

- Read an optional `currency` field from the request body. Validate it's
  either `"IDR"` or `"USDT"` (reject anything else with 400); default to
  `"IDR"` when absent, preserving current behavior for any other caller.
- Pass `currency` through to `adjustWallet(prisma, userId, deltaDec, { ...,  currency })`.
- Fold the currency into the audit log sentence (`logAdminAction`), e.g.
  `` `Adjusted ${currency} wallet by ${deltaDec.toString()}. Note: "${note...}".` ``
  — keeps `docs/LOGGING.md`'s natural-language convention.

No other backend changes — `adjustWallet`, `getUser`, `listWalletLedger`,
and the schema already support everything the UI needs.

### 2. Frontend types — match the real API shape

File: `apps/web-admin/client/src/pages/UserDetailPage.tsx`, `UserDetail`
interface (lines 23-30).

- `user`: drop `walletCurrency`; add `walletBalanceUsdt: string` alongside
  the existing `walletBalance: string`.
- `ledger`: replace `{ id: number; delta: string; balance: string; ... }`
  with `{ delta: string; balanceAfter: string; currency: string; reason: string; note: string | null; createdAt: string }`
  — matching `WalletLedgerEntry` in `packages/db/src/crud/users.ts` (no `id`
  field on this type).

### 3. Profile card — show both balances

Replace the current line:
```tsx
<div className="flex justify-between"><span className="text-ink-soft">Wallet</span><span className="font-mono">{user.walletBalance} {user.walletCurrency}</span></div>
```
with a `CurrencyStack` (`apps/web-admin/client/src/components/shared/CurrencyAmount.tsx`),
the same component already used one row below for "Total spent" — visually
consistent, no new component needed:
```tsx
<div className="flex justify-between"><span className="text-ink-soft">Wallet</span><CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} /></div>
```

### 4. Wallet Adjustment form — currency toggle

Add a `walletCurrency` piece of local state (`useState<"IDR" | "USDT">("IDR")`)
alongside the existing `walletForm` state. Render a small two-button
segmented toggle (IDR / USDT) next to the amount input — active button
styled distinctly (e.g. `variant="default"` vs `variant="outline"`), same
`Button` primitive already imported on this page, no new UI component
needed. Include the selected currency in the mutation:
```tsx
mutationFn: () => apiPost(`/api/users/${userId}/wallet`, { ...walletForm, currency: walletCurrency }),
```
Reset `walletCurrency` back to `"IDR"` in `onSuccess` alongside the existing
form reset, so the toggle doesn't silently stick on USDT for the next
adjustment.

### 5. Wallet Ledger table — show currency, fix field mismatch

- Add a "Currency" column rendering `<Badge variant="outline">{l.currency}</Badge>`,
  consistent with how the Role badge is already styled elsewhere on this page.
- Fix the "Balance" column to read `l.balanceAfter` instead of the
  nonexistent `l.balance`.
- `DataTable`'s `keyExtractor` takes only the row, and ledger rows have no
  `id`. Map the ledger array to attach a positional key before rendering:
  ```tsx
  const ledgerRows = data.ledger.map((l, i) => ({ ...l, _key: i }));
  ```
  and use `keyExtractor={(l) => l._key}`. Position is stable for a given
  query response (the list isn't reordered client-side), so this is safe.

## Testing

- Update `UserDetailPage.test.tsx`'s `USER_DETAIL` fixture to match the new
  shape: replace `user.walletCurrency` with `walletBalanceUsdt`, and give
  `ledger` entries `balanceAfter`/`currency` instead of `balance`/`id`.
- Add a test asserting both wallet balances render (e.g. via
  `CurrencyStack`'s rendered text).
- Add a test asserting the wallet-adjust mutation includes `currency: "USDT"`
  in its POST body when the USDT toggle is selected before submitting.
- Add/extend a web-admin API test (`apps/web-admin/test/web.test.ts` or the
  `api/users` test file, whichever already covers `POST /api/users/:userId/wallet`)
  asserting: adjusting with `currency: "USDT"` moves `walletBalanceUsdt` and
  leaves `walletBalance` untouched, and an invalid `currency` value is
  rejected with 400.

## Verification

1. `pnpm --filter @app/web-admin-client build`, `pnpm typecheck`, `pnpm test`
   all green.
2. Manually: open a customer detail page in the admin panel, confirm the
   Profile card shows both IDR and USDT wallet lines; adjust the USDT
   balance via the form and confirm only `walletBalanceUsdt` changes (check
   via the ledger table's new Currency column) while the IDR balance and its
   ledger rows are unaffected.
