/**
 * @app/web-ui — shared web theme for web-admin AND the storefront.
 *
 * `views/` holds the Nunjucks partials both apps include so the two webs stay
 * visually identical (plan.md §6 decision B):
 *   - `_theme.njk`  — fonts + Tailwind CDN config + component @layer + htmx/lucide
 *   - `_macros.njk` — csrf_field / ic / flash / status_badge / empty_row
 *
 * Each app configures its Nunjucks loader with TWO paths: its own `views/`
 * first, then this shared dir — so app-local templates win and shared partials
 * resolve as a fallback. Change a token here → both webs change.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolved relative to this source file, which breaks once the app is bundled
// (import.meta.url then points at dist/). Allow an explicit override so the
// bundled deploy can point at the shipped shared views/ dir, exactly like the
// web-admin VIEWS_DIR override.
export const sharedViewsDir: string =
  process.env.SHARED_VIEWS_DIR ?? join(HERE, "..", "views");
