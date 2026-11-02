# Visual state design audit (spec section D)

Static audit of `apps/web-admin/client/src` and `apps/storefront/client/src`
on 2026-11-02. Both apps use `lucide-react` 1.58 and their own Tailwind tokens;
nothing is shared between the apps and no dependency was added.

**Runtime:** Not Tested. The states changed here only render when a request
fails, which needs request mocking against built bundles and a seeded
database; that browser run was not done. Every change below is covered by
jsdom tests that assert the icon, its `aria-hidden`, the tone classes and the
roles.

Related: loading primitives in [docs/ui/03_COMPONENT_LIBRARY.md](../ui/03_COMPONENT_LIBRARY.md)
and [docs/ui/08_UX_RULES.md](../ui/08_UX_RULES.md); the React Doctor record in
[docs/REACT_DOCTOR_PHASE_1_REPORT.md](../REACT_DOCTOR_PHASE_1_REPORT.md).

## Tokens used for semantics

| Meaning | Admin token | Storefront token |
|---|---|---|
| Destructive / error | `rust`, `rust-tint`, `rust-dark` | same names |
| Warning | `amberx`, `amberx-tint` | same names |
| Success | `grass`, `grass-tint`, `grass-dark` | same names |
| Info | `pine`, `pine-tint`, `pine-dark` | same names |
| Neutral | `ink-faint`, `ink-soft` | same names |

Values match between the apps (`apps/*/client/src/index.css`).

## Icon behaviour

`lucide-react` 1.58 adds `aria-hidden="true"` to every icon that has no
accessible prop (`buildLucideIconNode`). Decorative icons are therefore hidden
by default; the new code also sets it explicitly so tests can pin it. Icon-only
buttons in both apps carry `aria-label` (checked: upload Retry/Remove,
BulkFailuresNotice dismiss, storefront picker buttons).

## State-by-state result

| State (spec icon) | Web admin | Storefront |
|---|---|---|
| Empty (`inbox`) | `EmptyState` with an entity icon on list pages; 19 compact call sites have none (VIS-11, Open) | `EmptyState` / `StatusScreen`, icon required; OK |
| Loading (`loader-circle` / skeleton) | `Spinner` (LoaderCircle), `Skeleton`, `LoadingRegion`, `Button pending`; motion-safe (LD-01, Fixed) | same pattern, own components; motion-safe (LD-01, Fixed) |
| Success (`circle-check`) | toasts; `SaveConfirmDialog` and `ImageUploadField` use `motion-safe:animate-checkmark-pop` after the server answers; OK | `Alert tone="success"` (CheckCircle); success cards gated by server state; OK |
| Error (`circle-alert`) | `QueryErrorNotice` first load, `BulkFailuresNotice`, `ErrorBoundary`: had no icon. **Fixed `5162acb7`** (VIS-01, VIS-03) | `ErrorState` (ServerCrash, rust) OK; `Alert` error used the warning triangle. **Fixed `d158b647`** (VIS-05); `ErrorBoundary` icon added (VIS-06) |
| Failed upload (`file-x`) | text "failed" only. **Fixed `5162acb7`** (VIS-04) | text only. **Fixed `d158b647`** (VIS-07) |
| Offline (`wifi-off`) | none (VIS-08, Open; depends on ADM-M1) | none (VIS-08, Open; depends on SF-M3) |
| Slow network (`signal-low`) | none; no timeout exists (ADM-M3) | none (SF-M3) |
| Zero results (`search-x`) | SearchPage uses SearchX; list pages reuse the entity icon with distinct copy and Clear Filters (VIS-10, Open) | search overlay and product search use EmptyState; OK. Overlay error branch missing (SF-M7) |
| Permission denied (`shield-alert`) | no state; 403 shows a permission message (ADM-M6, VIS-09) | `PermissionDeniedState` (ShieldX) exists, no call sites (VIS-09) |
| Session expiry (`lock-keyhole`) | banner was rust with no icon. **Fixed `5162acb7`**: LockKeyhole, warning tone (VIS-02) | Checkout/cart session notices use `Alert`; recovery scope uses LockKeyhole; OK |
| Form invalid (`circle-alert`) | inline field errors in rust text | inline errors via `FormField`; error `Alert` now circle-alert |
| Form valid (`circle-check`) | not shown as a separate state (n/a) | n/a |
| Uploading (`upload-cloud`) | "Uploading N%" from 0. **Fixed**: CloudUpload, words until measured | CloudUpload added; already no fake 0% (`a6481143`) |
| Uploaded file (`file-check`) | raw word "ready". **Fixed**: FileCheck + "Uploaded" | FileCheck added beside "Ready" |
| Preview unavailable (`file-warning`) | readonly ticket photos render as broken images (ADM-L2, Open) | `SupportFilePreview` falls back to a file chip; OK |

## Checklist (section D)

| Item | Result |
|---|---|
| All relevant states have a visual representation | Partly: offline, slow network and permission denied have none (VIS-08, VIS-09) |
| Icon, stroke, size and placement consistent | Notices: 16 px leading icon (`h-4 w-4`), lucide default stroke; full-page states 48 px (`h-12 w-12`); upload rows 14 px. Consistent within each app |
| Semantic colours from tokens | Yes; the admin notice now uses `amberx` for warnings instead of a rust tint |
| Failed visually distinct from warning | Fixed: errors use circle-alert, warnings triangle-alert, in both apps |
| Upload numbers only when measured | Yes in both apps after `a6481143` (storefront) and `5162acb7` (admin picker); admin `ImageUploadField` already used real XHR progress |
| Success animation only after backend confirm | Yes: checkmark pop only on resolved saves; storefront success gated on server state |
| Motion respects prefers-reduced-motion | Yes: `motion-safe:` on spinners/skeletons/pop, global `prefers-reduced-motion` CSS rule in both `index.css`, `MotionConfig reducedMotion="user"` in both `main.tsx` |
| Decorative icons hidden; meaningful icons labelled | Yes (lucide default + explicit); icon-only buttons have `aria-label` |
| Colour not the only differentiator | Fixed for error vs warning; states also differ by text and role (`alert` vs `status`) |
| Consistent across apps without identical layouts | Yes: same tokens, icons and roles; layouts stay per app |

## Changes made

| Commit | Change | Tests |
|---|---|---|
| `5162acb7` | Admin `QueryErrorNotice` (error vs warning icon and tone), `SessionExpiredBanner` (LockKeyhole, warning), `BulkFailuresNotice` (CircleAlert), `ErrorBoundary` (CircleAlert, role=alert), `SupportUploadPicker` (state words + icons, no fake 0%) | `components/shared/stateVisuals.test.tsx` (5), `SupportUploadPicker.test.tsx` (+5) |
| `d158b647` | Storefront `Alert` error icon, `RefreshFailedNotice` warning icon, `ErrorBoundary` icon, `SupportUploadPicker` state icons | `components/shop/stateVisuals.test.tsx` (4), `SupportUploadPicker.test.tsx` (+3), `Flash.test.tsx` (1 assertion changed on purpose) |
