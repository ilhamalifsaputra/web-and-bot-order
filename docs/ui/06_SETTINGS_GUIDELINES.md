# 06 — Settings Guidelines

**Scope:** how configuration pages work — grounded entirely in
`apps/web-admin/client/src/pages/SettingsPage.tsx`, the app's single, canonical
settings surface, plus its extracted composites in `components/shared/`
(`SettingsSearch`, `SettingsNav`, `SettingsHealthCard`, `SettingsSaveStatus` —
full specs in `03_COMPONENT_LIBRARY.md`). Every rule below is the pattern the
page and these composites already implement.

Remember the repo-wide rule from the root `CLAUDE.md`: **Settings edits are
whitelist-only** — the server only accepts keys on an explicit `EDITABLE` list.
Never widen that whitelist casually; it's the main "don't brick the bot/shop"
guardrail. The client's grouping constants (`BRANDING_KEYS`, `TELEGRAM_KEYS`,
`FX_KEYS`, `PAY_CRED_GROUPS` in `SettingsPage.tsx`) **must match the server-side
whitelist exactly** — a field that exists on the server but isn't grouped on the
client falls through to the catch-all "Other Settings" card automatically, so
grouping is a UX nicety, not a security boundary.

---

## 1. Navigation

Settings does **not** use an accordion or collapse/expand pattern. It uses a **flat
list of `Card`s, each with a fixed section anchor id**, plus a sticky **jump-nav**
alongside the content:

```tsx
<div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-8">
  <div className="lg:sticky lg:top-4">
    <SettingsSearch value={query} onChange={setQuery} />
    <SettingsNav topLinks={...} group={paymentGatewaysGroup} bottomLinks={...} />
  </div>
  <div className="flex flex-col gap-6 max-w-2xl [&>*]:scroll-mt-20">
    {/* the Cards */}
  </div>
</div>
```

- On **desktop (`lg`+)**: a `220px` sticky sidebar column of section links,
  `top-4`, `flex-col`.
- On **mobile/tablet (<`lg`)**: the same links render as a horizontally-scrollable
  sticky bar at the top (`sticky top-0`, `overflow-x-auto`, `-mx-4`/`-mx-5` bleed to
  the content edge).
- Each section link is only rendered if that section has content (e.g. the
  "General" link only appears if `BRANDING_KEYS` produced any fields) — never show a
  nav link to an empty section.
- Each `Card`'s wrapper carries `scroll-mt-20` so an anchor jump doesn't hide the
  section's top under the sticky nav.
- **Scrollspy**: `SettingsNav` (`components/shared/SettingsNav.tsx`) runs one
  `IntersectionObserver` (guarded with `typeof IntersectionObserver !== "undefined"`
  so it degrades to no-highlighting rather than crashing in an environment without
  it) over every visible section's `id`, highlighting the topmost intersecting
  section's nav link (`bg-pine-tint text-pine`, `aria-current="page"` — the same
  active-state classes `Sidebar` uses) and auto-scrolling that link into view
  (`scrollIntoView({block:"nearest",inline:"nearest"})`, falling back to instant
  scroll under `prefers-reduced-motion: reduce`).
- **Search**: `SettingsSearch` (`components/shared/SettingsSearch.tsx`) is a plain
  controlled filter `Input` above the nav — typing filters both the nav's links and
  the visible `FieldRow`s inside still-shown `Card`s to whatever matches (section
  title or field label), with the matched substring wrapped in `<mark>` via its
  exported `highlightMatch()` helper. Pure client-side, no debounce, no page reload.

**Rule: use this jump-nav + flat-cards pattern for any new settings surface. Do not
introduce an accordion/collapsible-section pattern** — it's a deliberate choice
(F-012 in `docs/ui-refactor/`) so an admin can jump straight to one section instead
of expanding/collapsing through 9+ others.

**Exception — the Payment Gateways nav group only**: the nav's list of individual
gateway links (TokoPay, PayDisini, NOWPayments, Bybit, Bybit BSC, Binance Internal
Transfer) may collapse/expand as a group, via a `<button aria-expanded>` toggle
above the list (desktop nav column only — the mobile horizontal-scroll bar always
shows every gateway link, since there's no vertical list to shorten there). State
persists to `localStorage` (`settings-nav-pay-expanded`, defaulting to expanded when
unset) via `SettingsNav`, wrapped in a try/catch since some environments (private
browsing, some test runners) don't provide `localStorage` at all. **This is a
navigation-only affordance — the payment gateway content `Card`s in the main
column stay exactly as flat/uncollapsed as every other section.** Do not extend
collapsing to any other nav group, and never make the content column itself
collapsible.

## 2. Grouping

Fields are grouped by **domain**, one `Card` per group: General (branding), Telegram
& Bot, one `Card` **per payment gateway** (not one shared "Payments" card), Exchange
Rates, Security, and a catch-all **"Other Settings"** card for any field that isn't
in a named group (`fieldsOther()` — the safety net for future fields added on the
server before the client groups them).

When adding a new settings field:
1. Add its key to the correct existing group's key list (`BRANDING_KEYS`,
   `TELEGRAM_KEYS`, `FX_KEYS`, or the relevant `PAY_CRED_GROUPS` entry) if it belongs
   to one.
2. If it starts a genuinely new domain (not a fit for any existing group), add a new
   named group + `Card` + nav link, following the same shape.
3. If you don't group it, it will still appear (under "Other Settings") — but do
   group it; the catch-all is a fallback, not a resting place for new fields.

## 3. Field display — `FieldRow`

Every setting field, regardless of group, renders through the same row pattern:

```tsx
<div className="flex items-start justify-between py-3">
  <div className="flex-1 min-w-0 mr-4">
    <div className="text-sm font-medium text-ink">
      {field.secret && <KeyRound className="mr-1 inline h-3.5 w-3.5 text-ink-faint" aria-label="Sensitive field" />}
      {field.label}
      {field.needsRestart && <span className="text-xs text-ink-soft ml-2">(restart required)</span>}
    </div>
    {!editing && (
      <div className="mt-1 text-xs text-ink-soft">
        {field.secret
          ? (field.hasValue ? "••••••••" : <em>not set</em>)
          : (field.value || <em>not set</em>)}
      </div>
    )}
    {editing && (
      <div className="mt-2 flex flex-wrap gap-2 items-center">
        <Input type={field.secret ? "password" : "text"} value={value} onChange={...} autoFocus className="w-full max-w-sm" />
        <Button size="sm" onClick={() => setConfirmOpen(true)}><Save className="h-4 w-4"/>Save</Button>
        <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
      </div>
    )}
  </div>
  <SaveConfirmDialog open={confirmOpen} ... onConfirm={save} />
  {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><SquarePen className="h-4 w-4"/>Edit</Button>}
</div>
```

Multiple `FieldRow`s inside one `Card`'s `CardContent` use `divide-y divide-line` for
separation.

Rules:
- **View mode is the default** — a field never shows an always-open input; clicking
  "Edit" reveals it.
- **Secrets** (`field.secret`): show a `KeyRound` icon next to the label, mask the
  display value as `••••••••` (never partially reveal a stored secret in view mode),
  and use `type="password"` while editing.
- **`needsRestart`**: an inline `"(restart required)"` caption next to the label —
  never a separate banner per field. If a whole *section* needs a restart notice
  (multiple related fields), still express it per-field, not as one section-level
  banner, so it stays scoped to exactly what changed.
- **Confirm dialogs render unconditionally** (not `{editing && <SaveConfirmDialog/>}`)
  — `save()` flips `editing` to `false` as soon as the request resolves, which would
  unmount a conditionally-rendered dialog mid-animation and cut off the
  checkmark-pop. Keep the dialog mounted; gate only its `open` prop.

## 4. Save indicator / confirmation

Every settings mutation — a field save, a payment-gateway toggle, an FX refresh, a
password change, enabling/disabling 2FA — goes through
**`SaveConfirmDialog`** (`components/shared/SaveConfirmDialog.tsx`) before the
request fires:

```tsx
<SaveConfirmDialog
  open={confirmOpen}
  onOpenChange={setConfirmOpen}
  title={`Save "${field.label}"?`}
  description="This updates the live setting immediately."
  onConfirm={save}
/>
```

This is the settings-flavored confirm dialog (built on `Dialog`, distinct from the
generic destructive `ConfirmDialog` used elsewhere — see `03_COMPONENT_LIBRARY.md`):
it shows a checkmark-pop animation on success and accepts an async `onConfirm` whose
resolved return value can supply a success message (see the FX-refresh example
below). **Every settings mutation must go through it** — never wire a `Switch` or
"Save" button directly to a mutation without this confirm step; settings changes
take effect immediately in production, so the confirm step is the only guard against
a misclick.

## 5. Credential handling

- **API keys / secrets**: `field.secret: true` → masked (`••••••••`) in view mode,
  `type="password"` input in edit mode, `KeyRound` icon marker. Never render a
  stored secret's actual value in the DOM — the server only ever returns
  `hasValue: boolean`, not the value itself, for secret fields.
- **Reveal/mask** (a *different* pattern, for credentials that legitimately need to
  be read back — e.g. a stock item's delivered account credentials, not a settings
  API key): an `Eye`/`EyeOff` ghost icon button toggles a per-row `revealed` state.
  See `StockProductPage.tsx` for the live example. Use this pattern (not the
  settings `••••••••`-forever mask) specifically when the admin has a legitimate,
  occasional need to read the actual value back.
- **Copy button**: a ghost icon button that copies the value to the clipboard and
  swaps its icon from `Copy` to `Check` for a moment as feedback:
  ```tsx
  <Button variant="ghost" size="sm" aria-label={`Copy account for stock item ${item.id}`}
          onClick={() => copyCredential(item)}>
    {copiedId === item.id ? <Check className="h-3.5 w-3.5 text-grass" /> : <Copy className="h-3.5 w-3.5" />}
  </Button>
  ```
  Use this exact icon-swap feedback pattern (not a toast) for copy actions — it's
  immediate and doesn't require a separate notification for such a low-stakes
  action.
- **Copy-while-editing** (a settings-specific narrower case): `FieldRow`'s edit
  mode shows a `Copy` ghost icon button next to a secret field's `Input`, copying
  the value **currently typed in the input**, not a previously-stored value (the
  server never sends one back — see above). It never appears in view mode, since
  there's nothing real to copy there. This is the only "copy a secret" affordance
  in Settings — do not add a view-mode copy button for a secret field.
- **Regenerate: deliberately not built.** Every current secret field (TokoPay
  secret, PayDisini API key, NOWPayments API key/IPN secret, Bybit/Binance API
  key/secret, the Telegram bot token) is a credential *issued by an external
  service*, not one this app generates — there is nothing for "Regenerate" to
  produce. Don't add a Regenerate button to a settings field unless a future field
  is genuinely a value this app itself generates (e.g. an app-issued webhook
  secret); model it on the FX-refresh pattern (§6) if that day comes, displaying
  the new value via the reveal/copy pattern (a *different* class of credential,
  above), not the settings mask.

## 6. Connection test / "verify integration" action

Modeled on the **FX-refresh button**'s shape, and now implemented for every
payment gateway plus the Telegram bot token/channel:

```tsx
async function refreshFx() {
  const result = await apiPost<{ ok: boolean; status: string; rate: string }>(
    "/api/settings/fx/refresh", {},
  );
  invalidate();
  return `Rate updated to ${result.rate} (${result.status})`;
}
// ...
<Button onClick={() => setFxConfirmOpen(true)} variant="outline">Refresh USDT Rate</Button>
<SaveConfirmDialog open={fxConfirmOpen} ... confirmLabel="Refresh" onConfirm={refreshFx} />
```

Pattern: an `outline` `Button` (disabled, with an inline reason, when the gateway
isn't `configured` yet) → `SaveConfirmDialog` confirm → an async action that calls
the server, invalidates the settings query where relevant, and returns a
**human-readable result string** describing what happened (not just "success").

**Test Connection** (`POST /api/settings/payments/:method/test`,
`apps/web-admin/src/lib/connectionTest.ts`) follows this exact shape for each
gateway. What each test actually proves differs by gateway, and the result string
says so:
- **Bybit / Binance Internal Transfer**: a real signed call to the *same read-only
  endpoint the production deposit poller uses* — a reliable pass/fail.
- **TokoPay / PayDisini**: these gateways' request/response shapes are documented
  as unverified assumptions in `packages/core/src/payments/{tokopay,paydisini}.ts`
  (no dedicated "ping" endpoint exists) — the test calls the read-only status-check
  endpoint with a sentinel reference id that can never exist, and surfaces the
  gateway's own raw response text rather than manufacturing a falsely-confident
  binary result.
- **NOWPayments**: same sentinel-id approach, but its header-based auth means a
  real HTTP 401/403 vs. 404 distinction is available, so this one *is* a reliable
  pass/fail.
- **Telegram** (`POST /api/settings/telegram/test`): re-runs the same
  `checkTokenWithTelegram`/`checkChannelWithTelegram` validators `/edit` already
  uses inline, against the *currently-saved* token/channel, without requiring a
  resave.

None of these tests mutate anything — they're safe to click repeatedly. "Refresh
Connections" (the page header's Quick Actions menu — see `03_COMPONENT_LIBRARY.md`
for the full menu spec) runs every gateway's test plus the Telegram test in
parallel and reports one combined result, following the same bulk-action
combined-toast convention as everywhere else in the app.

## 7. Configuration status

Configured-ness and the raw enabled/disabled toggle are now two separate,
independently-honest signals — a `StatusBadge` and the `Switch` — rather than one
combined text label:

```ts
function gatewayBadgeStatus(methodState: PayMethodState, testFailed: boolean): "CONFIGURED" | "NOT_CONFIGURED" | "ERROR" {
  if (!methodState.configured) return "NOT_CONFIGURED";
  if (testFailed) return "ERROR";
  return "CONFIGURED";
}
// ...
<StatusBadge status={gatewayBadgeStatus(methodState, testResult?.ok === false)} />
<Switch checked={methodState.enabled} onCheckedChange={...} />
```

`StatusBadge` (`components/shared/StatusBadge.tsx`) carries four settings-specific
tone-map entries for this: `CONFIGURED` (grass), `OPTIONAL` (neutral),
`NOT_CONFIGURED` (amberx), `ERROR` (rust — a failed Test Connection result, or a
failed live Telegram token/channel check). The same four statuses replace the
plain "not set" italic text on any field's empty view-mode value:
`field.secret`-and-empty renders `<StatusBadge status="NOT_CONFIGURED" />`
(a secret is required for its integration to function), any other empty field
renders `<StatusBadge status="OPTIONAL" />`. **No emoji anywhere** — Lucide is the
only icon system (`01_DESIGN_SYSTEM.md` §9); if a status needs an icon, add one to
`StatusBadge` itself, don't reach for a literal 🟢/🟡/🟠/🔴 glyph.

**Rule: the status badge must never claim more capability than the raw
`configured` fact supports** — a gateway can't actually process payments without
credentials regardless of what the `enabled` flag says, so `NOT_CONFIGURED` always
wins over `enabled` in the badge, even if the underlying toggle happens to be
`true`. The original version of this fix (F-013) collapsed both signals into one
combined text label for exactly this reason; splitting them back into a badge +
toggle is safe only because the badge itself never mentions `enabled` at all —
don't reintroduce a label that says "Enabled"/"Active" next to an unconfigured
gateway's badge.

The `Switch` itself always reflects the raw `enabled` value untouched by any of
the above, and flipping it goes through `SaveConfirmDialog` before the `/toggle`
call fires, with the confirm dialog's description stating the real-world
consequence ("Customers will be able to pay with this gateway immediately." /
"...will no longer be able to...").

## 8. Validation

Same manual pattern as the rest of the app (`04_CRUD_TEMPLATE.md` §4) — no schema
library. Settings-specific validation lives inline where needed (e.g. password
change requires `minLength={8}` on the `Input`, a 2FA code input is
`maxLength={6}`). Server-side errors surface via a local `error` state rendered as
`text-sm text-rust`.

## 9. Permission state

The only permission signal the client has is `data.isOwner` (from `useSettings()`).
Use it to gate owner-only sections/actions the same narrow way `SettingsPage.tsx`
does — a boolean condition wrapping a conditional render — rather than introducing a
broader roles/permissions framework (see `04_CRUD_TEMPLATE.md` §Permission State).

## 10. Progressive disclosure

The jump-nav (§1) *is* the settings page's progressive-disclosure mechanism — an
admin sees section titles up front and expands their attention to one section at a
time by scrolling/jumping, without individual fields being hidden behind an
extra click (accordion). Within a `Card`, the view→edit toggle on each `FieldRow`
(§3) is the field-level progressive disclosure: the raw editable input is hidden
until "Edit" is explicitly clicked, keeping the resting state of a settings page
scannable rather than a wall of open inputs.

## 11. Save status, restart, and quick actions

- **Global save status** (`SettingsSaveStatus`, `components/shared/SettingsSaveStatus.tsx`,
  rendered in `PageHeader`'s `actions` slot): there is no page-level draft/form —
  every field saves itself immediately and independently (§4) — so this pill is a
  *derived summary*, not a real "unsaved form" indicator. `useSettings()` (the
  shared hook, `hooks/useSettings.ts`) tracks a `Map<fieldKey, "editing"|"saving">`
  (each `FieldRow`/gateway card reports its own status up via a callback) plus a
  single `lastSavedAt` timestamp updated by every successful mutation across the
  page. Precedence: any field `"saving"` → "Saving…"; else any field `"editing"` →
  "Unsaved changes"; else `lastSavedAt` → "Saved {relative time}", decaying to
  "All changes saved" after ~2 minutes; else (nothing saved this session) → render
  nothing.
- **Restart Required**: `RestartRequiredBadge` (a small `TriangleAlert` + amberx
  pill) replaces the old plain `(restart required)` caption next to a field's
  label — still **per-field, never a page banner** (unchanged rule from §3). This
  is a *static* per-field marker (bot token/channel fields always carry it, since
  editing them always needs a restart) — it is not the same signal as whether a
  restart is actually pending right now.
- **Restart Bot** (a real action, not just the static badge above): `SettingsPage`
  tracks a session-local `restartPending` boolean, set `true` only when a
  `needsRestart` field's save actually succeeds this session, and cleared on a
  successful restart. The button posts to `POST /api/settings/restart` — a new,
  `currentAdmin`+owner-gated route, **deliberately separate** from
  `POST /setup/restart` (`apps/web-admin/src/routes/setup.ts`), which is
  intentionally unauthenticated because it runs before any admin session exists
  during the first-run wizard. Never wire a Settings-page button to
  `/setup/restart` directly.
- **Quick Actions** (`QuickActionsMenu`, page-local to `SettingsPage.tsx`, in
  `PageHeader`'s `actions` slot alongside the save-status pill): a `DropdownMenu`
  with Export Configuration, Backup Settings, Import Configuration, Restore
  Backup, Refresh Connections. Export/Backup and Import/Restore are the **same
  mechanism** under friendlier labels, not two parallel systems —
  `GET /api/settings/export` returns every `EDITABLE` key **except every
  `secret:true` key, which is omitted entirely, never redacted-in-place**, and
  `POST /api/settings/import` re-validates each field through the exact same
  per-field logic `/edit` uses (both routes call one shared `applyFieldEdit`
  function server-side) and silently skips any secret key present in an uploaded
  file as a defensive second layer. This menu must stay visually secondary
  (`variant="outline"`/`"ghost"`) — it's a convenience surface, not competition
  for the page's actual editing affordances.

## 12. Never do

- Never introduce an accordion/collapsible-section pattern for a settings page —
  use the flat-cards + jump-nav pattern, except the Payment Gateways **nav group**
  specifically, which may collapse (§1) — the content `Card`s never do.
- Never widen the server-side `EDITABLE` whitelist without review (root
  `CLAUDE.md`), and keep the client's grouping constants in sync with it.
- Never render a stored secret's real value from a settings field in view mode —
  mask it; only the reveal/copy pattern (for a different class of credential, §5) may
  show a real value, and only when the admin explicitly reveals it.
- Never wire a settings `Switch`/save action directly to a mutation without a
  `SaveConfirmDialog` step.
- Never show a status label that can contradict itself (e.g. "Enabled" on an
  unconfigured gateway) — configured/not-configured always gates the displayed
  label.
