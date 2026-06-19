# Branding controls — favicon, hero, bot banner & identity

**Date:** 2026-06-16
**Status:** Design — pending implementation plan

## Problem

Storefront branding is hardcoded: the home-page hero is a fixed Unsplash URL
(`apps/storefront/src/images.ts` → `HERO_IMAGE`) and there is **no favicon** at
all (`apps/storefront/views/base.njk` has no `<link rel="icon">`). Bot/website
identity settings (`banner_image`, `welcome`, `shop_name`, `shop_tagline`) are
scattered across the bot's Settings conversation and the web-admin Settings tabs.
The bot banner can only be set by sending a photo to the bot (web-admin shows it
as a placeholder "set it from the bot for now").

We want a single **Branding** page in web-admin where the owner uploads images
and edits identity text for both the website and the bot.

## Goals

- New web-admin **Branding** page consolidating all branding controls.
- Upload **favicon** (PNG/ICO/SVG) and **hero** image (JPG/PNG/WebP) for the
  storefront.
- Upload the **bot banner** image (JPG/PNG/WebP) from the web — no longer
  bot-only — and let the bot render it.
- Edit **shop name**, **shop tagline**, **welcome message** from the same page.
- Stay within project guardrails: no raw SQL in routes, no Telegram sends from
  the web, whitelist-only settings, audit every change, Decimal/i18n rules N/A
  here.

## Non-goals

- A separate favicon/branding for the web-admin panel itself (storefront only).
- Image cropping/resizing/optimisation in-app (operator uploads a sized image).
- Moving `support_whatsapp` (a contact control, not branding) — stays on Settings.
- A "reset to default" button — uploading a new file replaces the old one;
  default fallback applies only when the setting is empty.

## Settings keys

| Key                   | Holds                                                        | Consumed by            |
|-----------------------|-------------------------------------------------------------|------------------------|
| `web_favicon_url`     | `/uploads/branding/favicon-<hash>.<ext>` or empty           | storefront `<head>`    |
| `web_hero_url`        | `/uploads/branding/hero-<hash>.<ext>` or empty              | storefront home page   |
| `banner_image`        | upload path `/uploads/branding/banner-<hash>.<ext>` **or** a legacy Telegram file_id | bot main menu / product list |
| `banner_image_fileid` | cached Telegram file_id for the current upload-path banner  | bot (perf cache)       |
| `shop_name`           | text (existing)                                             | web + bot              |
| `shop_tagline`        | text (existing)                                             | web                    |
| `welcome`             | text (existing)                                             | bot greeting           |

`banner_image_fileid` is an internal cache, never editable in the UI, never
logged. It is cleared whenever a new banner is uploaded (the upload path's hash
changes, so a stale cache can't survive anyway, but we clear it explicitly).

## File storage

- All branding files live under `data/uploads/branding/` (created on demand),
  served at `/uploads/branding/...` by **both** storefront and web-admin via the
  existing `fastifyStatic` registration (`UPLOADS_DIR`).
- Filenames are hashed: `<kind>-<8-byte-hex>.<ext>` — collision-proof and
  cache-busting on replace.
- On replace, the previous file is deleted **only if** the old setting value was
  a local upload path (`startsWith("/uploads/")`) — never when it's a legacy
  Telegram file_id. Mirrors the product-photo delete in `catalog.ts`.

## Web-admin: routes & view

New module `apps/web-admin/src/routes/branding.ts`, registered in
`apps/web-admin/src/server.ts`. Follows the **product-photo-upload pattern**
(`catalog.ts` → `/catalog/product/:id/photo`): multipart parsed manually,
CSRF checked against `req.admin.csrf`, role gated with `canMutate`, audited with
`logAdminAction`.

Routes:

- `GET /branding` (`currentAdmin`) — renders `branding.njk` with current
  `web_favicon_url`, `web_hero_url`, `banner_image` (resolved to a previewable
  URL only when it is an upload path; a legacy file_id shows a "set from bot"
  note), `shop_name`, `shop_tagline`, `welcome`, plus `active_nav: "/branding"`.
- `POST /branding/favicon` (multipart) — accept `image/png`, `image/x-icon`,
  `image/vnd.microsoft.icon`, `image/svg+xml`; limit **1 MB**; save, delete old
  upload, `setSetting("web_favicon_url", path)`, audit `branding_favicon_upload`.
- `POST /branding/hero` (multipart) — accept `image/jpeg`, `image/png`,
  `image/webp`; limit **5 MB**; save, delete old, `setSetting("web_hero_url",
  path)`, audit `branding_hero_upload`.
- `POST /branding/banner` (multipart) — same MIME/limit as hero; save,
  delete old upload, `setSetting("banner_image", path)`,
  `deleteSetting("banner_image_fileid")`, audit `branding_banner_upload`.
- `POST /branding/banner/clear` (`csrfProtect`, form) — `deleteSetting`
  `banner_image` and `banner_image_fileid`, delete the upload file if any,
  audit `branding_banner_clear`.
- `POST /branding/text` (`csrfProtect`, form) — edit one of the whitelisted text
  keys (`shop_name`, `shop_tagline`, `welcome`); reuse the same validation shape
  as `/settings/edit` (key must be in an allowlist local to this route), audit
  `setting_set`.

MIME-extension map (shared helper):

```
favicon: { image/png: png, image/x-icon: ico, image/vnd.microsoft.icon: ico, image/svg+xml: svg }
raster:  { image/jpeg: jpg, image/png: png, image/webp: webp }   // hero + banner
```

View `apps/web-admin/views/branding.njk`: three image cards (Favicon, Hero,
Bot banner) each with a live preview + file input + upload button, and a small
form block for the text fields. Each image card shows a **recommended size**
helper line under the file input so the operator uploads correctly-proportioned
art. English labels, consistent with the rest of web-admin. Role gate: branding
is owner-class (same as catalog) — non-super admins see a read-only page or are
blocked by `canMutate` on the POSTs.

Recommended size / format guidance shown per section (advisory only — not
enforced; uploads are accepted at any dimension):

| Section    | Recommended size      | Notes                                              |
|------------|-----------------------|----------------------------------------------------|
| Favicon    | 512×512 px, square    | PNG/SVG preferred; min 48×48; transparent ok       |
| Hero       | 1600×900 px (16:9)    | Landscape; JPG/WebP for photos, ≤5 MB              |
| Bot banner | 1280×720 px (16:9)    | Shown as a Telegram photo above the menu; ≤5 MB    |

Nav: add a **Branding** link in `apps/web-admin/views/base.njk` inside the
Settings dropdown (next to Settings / Team), icon `image`, active when
`active_nav == "/branding"`.

Settings page cleanup (`apps/web-admin/src/routes/settings.ts` +
`settings.njk`): remove `shop_name`, `shop_tagline`, `welcome`, `banner_image`
from their current UI groups (`WEBSITE_KEYS`, `BOT_MESSAGE_KEYS`) so they show
only on Branding. **Keep** them in the `EDITABLE` whitelist (the generic
`/settings/edit` remains a safe fallback and the leftover-guard still lists
them in the "all saved options" table). `support_whatsapp` stays in
`WEBSITE_KEYS`.

## Storefront: consumption

- `apps/storefront/src/shop.ts` `shopContext`: also read `web_favicon_url`;
  expose `favicon_url` = setting value or default `/static/favicon.svg`. Now on
  every page via `base.njk`.
- `apps/storefront/views/base.njk` `<head>`: add
  `<link rel="icon" href="{{ favicon_url }}">`.
- Ship a default `apps/storefront/static/favicon.svg` so there is always an icon
  before any upload.
- `apps/storefront/src/routes/home.ts`: read `web_hero_url`; pass
  `hero_image: heroUrl || HERO_IMAGE` (the `images.ts` constant stays as the
  default). No template change needed (`home.njk` already renders `hero_image`).

## Bot: banner rendering

The banner value may now be a local upload path. grammY `replyWithPhoto` accepts
a `string` (file_id **or** URL) or an `InputFile`. Because bot and web share the
`data/uploads` filesystem, the bot sends an uploaded banner via `InputFile` and
caches the resulting Telegram file_id so it re-uploads at most once per banner.

- `apps/order-bot/src/handlers/customer.ts`:
  - `bannerPhoto()` (replaces the current `bannerImage()`): read `banner_image`.
    - empty → `undefined`.
    - upload path (`startsWith("/uploads/")`): if `banner_image_fileid` is set,
      return that cached file_id (string). Otherwise return
      `new InputFile(join(UPLOADS_ROOT, relPath))` where
      `UPLOADS_ROOT = process.env.UPLOADS_DIR ?? join(process.cwd(), "data", "uploads")`.
    - otherwise (legacy Telegram file_id): return the string unchanged.
  - After a successful banner photo send from an `InputFile`, persist the
    returned `msg.photo.at(-1).file_id` to `banner_image_fileid` so later renders
    reuse it. Implemented via an optional `onPhotoSent?(fileId)` callback passed
    into `renderMenu` (keeps `renderMenu` generic).
- `apps/order-bot/src/util/chat.ts` `renderMenu`: widen the `photoFileId`
  parameter type to `string | InputFile`; add the optional `onPhotoSent`
  callback invoked with `msg.photo.at(-1).file_id` after a fresh
  `replyWithPhoto`. No behavioural change for the existing file_id path.
- The bot's existing Settings → Banner image conversation
  (`apps/order-bot/src/conversations/admin.ts`) keeps working unchanged: a photo
  sent to the bot still stores a Telegram file_id in `banner_image`, which the
  new resolver treats as the legacy branch.

**Guardrail check:** the web only writes settings + files; every Telegram send
still happens in the bot. The `banner_image_fileid` write happens inside the bot
process, once per new banner.

## Security

- Uploaded **SVG** can embed `<script>` that executes if a visitor opens
  `/uploads/branding/favicon.svg` directly (same origin as both apps). As a
  favicon (`<link rel="icon">`) it never executes scripts, but direct
  navigation is a stored-XSS vector.
  - Mitigation: on the `/uploads/` `fastifyStatic` registration in **both**
    apps, add `setHeaders` to send `X-Content-Type-Options: nosniff` and
    `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`
    (no `script-src`), so an SVG opened directly cannot run JS.
  - Branding uploads are owner/super-only (`canMutate`), so the upload surface
    is already restricted.
- MIME allowlist enforced server-side (the file input `accept` is convenience
  only); size limits 1 MB favicon / 5 MB hero & banner via `req.parts` limits.
- Never log file bytes or file_ids in audit details — only filenames/keys
  (CLAUDE.md: never log payment-proof `file_id`; banner file_id is not a payment
  secret but we keep details to `filename=…`).

## Testing (Vitest)

- `apps/web-admin/test` — new `branding.test.ts` mirroring product-photo tests:
  - favicon upload happy (PNG) sets `web_favicon_url`; hero (JPG) and banner
    (PNG) happy paths.
  - auth-fail (no session) and bad-CSRF rejected for each POST.
  - wrong MIME rejected (e.g. `text/plain`, and `image/gif` for hero).
  - banner upload clears `banner_image_fileid`.
  - text edit happy + rejects a non-whitelisted key.
- `apps/storefront/test` — home renders the custom hero when `web_hero_url` is
  set, falls back to default otherwise; `base` emits `<link rel="icon">` with
  the configured favicon and with the default.
- `apps/order-bot/test` — `bannerPhoto` resolves: empty → undefined, legacy
  file_id → passthrough string, upload path with cache → cached file_id, upload
  path without cache → `InputFile`. (Caching write covered with a fake
  `setSetting`.)

## Open questions

None blocking. Banner delivery uses `InputFile` + file_id cache (works in dev
and prod) rather than a public URL (which would require the storefront to be
internet-reachable by Telegram).
