# Hero: replace default Unsplash photo with a brand gradient

**Date:** 2026-06-24
**Status:** Design — approved, implementing

## Problem

The storefront home hero (`apps/storefront/views/home.njk`) renders a photo
via `<img src="{{ hero_image }}">`. `hero_image` resolves in
`apps/storefront/src/routes/home.ts` as `heroUrl || HERO_IMAGE`: `heroUrl` is
the admin-uploaded hero from the web-admin Branding page (`web_hero_url`
setting; see `docs/superpowers/specs/2026-06-16-branding-controls-design.md`),
and `HERO_IMAGE` is a hardcoded Unsplash hotlink
(`apps/storefront/src/images.ts`). A dark tint
(`bg-gradient-to-br from-ink/95 via-ink/85 to-pine-dark/80`) sits on top of the
photo so the white hero text stays readable.

The request: change the hero's default look to a gradient color instead of a
stock photo, without breaking the Branding hero-upload feature.

## Goals

- When no admin hero is uploaded (`web_hero_url` unset), the hero background
  is a brand-colored CSS gradient — no photo, no external image request.
- When an admin hero *is* uploaded, behavior is unchanged: photo + the
  existing dark tint overlay.
- Drop the `HERO_IMAGE` Unsplash hotlink entirely (addresses the standing TODO
  in `images.ts` about not hotlinking Unsplash at scale, at least for the
  hero).

## Non-goals

- Changing the Branding page, the `web_hero_url` setting, or the upload flow.
- Changing `CATEGORY_IMAGES`/`PLACEHOLDER` in `images.ts` (separate concern).
- A "no photo, ever" mode — admin-uploaded photos still render as photos.

## Design

Gradient color, chosen to match the existing overlay's hue family (just fully
opaque instead of a tint over a photo): `bg-gradient-to-br from-ink via-pine-dark
to-pine` — dark navy bleeding diagonally into the brand's confident blue.

`apps/storefront/src/routes/home.ts` passes `hero_image: heroUrl || null`
(instead of falling back to a constant). `home.njk` branches:

```njk
{% if hero_image %}
<img src="{{ hero_image }}" alt="" aria-hidden="true" loading="eager" decoding="async"
     class="absolute inset-0 h-full w-full object-cover">
<div class="absolute inset-0 bg-gradient-to-br from-ink/95 via-ink/85 to-pine-dark/80"></div>
{% else %}
<div class="absolute inset-0 bg-gradient-to-br from-ink via-pine-dark to-pine"></div>
{% endif %}
```

`HERO_IMAGE` is removed from `images.ts` (and the now-stale `home.ts` import).

## Testing

`apps/storefront/test/storefront.test.ts` (`describe("hero image")`):
- "uses the configured hero when web_hero_url is set" — unchanged.
- "falls back to the default hero when unset" — rewritten to assert the
  response does **not** contain `images.unsplash.com` and does contain the
  gradient class string `from-ink via-pine-dark to-pine`.

## Docs

`DOCS.md`'s branding settings table row for Hero updates its fallback
description from `HERO_IMAGE` to "brand gradient (no photo)".
