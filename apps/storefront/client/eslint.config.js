// Storefront SPA — token-only styling gate (design-system spec §7.3).
//
// MINIMAL, single-purpose config. Its ONLY job is to fail the build when
// application code (src/**) reintroduces an OFF-TOKEN value:
//   1. a Tailwind arbitrary value that hard-codes a colour or a px length
//      -- `text-[#3B82F6]`, `bg-[rgba(15,23,42,.35)]`, `w-[437px]`, `mt-[13px]`
//   2. a raw hex / rgb() / hsl() colour literal in a .tsx/.ts file
//   3. a hard-coded px / rem / em length inside an inline `style={{ }}`
//
// Relative / content-derived arbitrary values (`aspect-[4/3]`, `min-h-[100svh]`,
// `w-[36%]`, `max-w-[10rem]`, `grid-cols-[1fr_320px]`) are NOT banned — only the
// px + colour forms above. Everything else (code style, import order, hooks,
// a11y) is OUT OF SCOPE.
//
// --- Why not `eslint-plugin-tailwindcss` / `tailwindcss/no-arbitrary-value`? ---
// The plugin IS installed (see package.json) and its rules are available for a
// later per-page adoption once a page has been through §7.3 component-mapping.
// It is NOT the primary gate here because `no-arbitrary-value` has zero options
// (verified against v4.4.0 docs): it bans EVERY `foo-[...]` unconditionally,
// including the ~20 legitimate responsive values this un-migrated storefront
// still uses. The only way to make its baseline clean is a per-file allowlist,
// which switches the rule OFF for whole files — and that neuters the gate on
// exactly the pages a migration task will touch. A value-level
// `no-restricted-syntax` matcher (below) is the brief's sanctioned equivalent:
// it stays active on every file and only fires on the px/colour forms.
//
// `tailwindcss/no-custom-classname` is deliberately NOT enabled — it would flag
// every legacy `.btn` / `.card` / `.field` / `.chip` / `.denom-card` class.

import tseslint from "typescript-eslint";
import tailwindcss from "eslint-plugin-tailwindcss";
import { fileURLToPath } from "node:url";

// Absolute path to the Tailwind v4 CSS-first config (the `@theme` block lives
// in src/index.css — there is no tailwind.config.js). Required by
// eslint-plugin-tailwindcss v4 when any of its rules are switched on.
const cssConfigPath = fileURLToPath(new URL("./src/index.css", import.meta.url));

// --- shared regex fragments (JS RegExp syntax, used inside esquery selectors) --

// Raw colour literal: #rgb .. #rrggbbaa, or rgb()/rgba()/hsl()/hsla().
const RAW_COLOR = String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(`;

// A Tailwind arbitrary value that bakes in a colour or an absolute px length:
//   -[ ...#hex... ]  |  -[ ...rgba(...)... ]  |  -[ ...12px... ]
// (rem / % / vw / vh / svh / fr / ratios / gradients, and calc()/env()
// expressions with no `px` term, are NOT matched — those are allowed. Note a
// `calc()`/`env()` that DOES contain a px length — `w-[calc(100%-20px)]` — is
// still flagged, because it carries a hard-coded px value.)
const ARBITRARY_OFFTOKEN = String.raw`-\[[^\]]*(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^\]]*\)|\d(?:\.\d+)?px)[^\]]*\]`;

// A hard-coded absolute length inside an inline style string.
const INLINE_LENGTH = String.raw`\d(?:\.\d+)?(?:px|rem|em)\b`;

const MSG_ARBITRARY =
  "Off-token Tailwind arbitrary value (hard-coded colour or px). Use a design token utility (bg-pine, text-ink, p-4, …) or add a --gg-* extension token in src/styles/tokens.extensions.css and log it in docs/implementation/extensions.md (§26.2).";
const MSG_HEX =
  "Raw colour literal in application code. Reference a design token instead; raw colour values belong only in src/styles/**.";
const MSG_INLINE_LEN =
  "Hard-coded length in an inline style. Use a Tailwind spacing utility or a token. If it is genuinely a device measurement (safe-area inset, etc.), add the file to the allowlist block in eslint.config.js with a reason.";

const arbitrarySelectors = [
  { selector: `Literal[value=/${ARBITRARY_OFFTOKEN}/]`, message: MSG_ARBITRARY },
  { selector: `TemplateElement[value.raw=/${ARBITRARY_OFFTOKEN}/]`, message: MSG_ARBITRARY },
];
const colorSelectors = [
  { selector: `Literal[value=/${RAW_COLOR}/]`, message: MSG_HEX },
  { selector: `TemplateElement[value.raw=/${RAW_COLOR}/]`, message: MSG_HEX },
];
const inlineLenSelectors = [
  { selector: `JSXAttribute[name.name='style'] Literal[value=/${INLINE_LENGTH}/]`, message: MSG_INLINE_LEN },
  { selector: `JSXAttribute[name.name='style'] TemplateElement[value.raw=/${INLINE_LENGTH}/]`, message: MSG_INLINE_LEN },
];

const GATE_FULL = ["error", ...arbitrarySelectors, ...colorSelectors, ...inlineLenSelectors];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "vite.config.ts",
      "vitest.config.ts",
      "eslint.config.js",
      "src/**/*.test.{ts,tsx}",
      "src/test/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    // `tseslint.configs.base` ONLY registers the TypeScript parser + plugin —
    // it enables ZERO rules. Deliberately not `js.configs.recommended` /
    // `tseslint.configs.recommended`: those turn on ~18 rules we'd then have to
    // disable by name, and a future ESLint / typescript-eslint minor bump could
    // add a new `recommended` rule that fails `pnpm test` repo-wide for a reason
    // unrelated to token styling. Starting from zero keeps this a single-purpose
    // gate — the only rule it asserts is `no-restricted-syntax` below.
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: {
      // The source carries two `// eslint-disable-next-line react-hooks/...`
      // comments written before ESLint existed here. We don't ship the
      // react-hooks plugin (out of scope), so a stub keeps the names resolvable.
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      // Stub: the source has two `// eslint-disable-next-line react-hooks/*`
      // comments predating any ESLint here. Registering the names (with no-op
      // rules) keeps those directives resolvable without pulling in
      // eslint-plugin-react-hooks, which is out of scope for this gate.
      // Still required after dropping the `recommended` presets: an unknown
      // rule name in a disable directive is a hard "Definition for rule … was
      // not found" error that `reportUnusedDisableDirectives: "off"` does NOT
      // silence.
      "react-hooks": {
        rules: {
          "exhaustive-deps": { create: () => ({}) },
          "rules-of-hooks": { create: () => ({}) },
        },
      },
    },
    rules: {
      // ---- THE GATE (the only thing this config asserts) ------------------
      "no-restricted-syntax": GATE_FULL,
    },
  },

  // -------------------------------------------------------------------------
  // eslint-plugin-tailwindcss — installed and wired (plugin + the mandatory v4
  // `cssConfigPath`), but no rule is switched on. See the header note for why
  // `tailwindcss/no-arbitrary-value` is not the gate. To adopt it for a single
  // page once that page has been through §7.3 component-mapping (task-7x):
  //
  //   { files: ["src/pages/Foo.tsx"], plugins: { tailwindcss },
  //     settings: { tailwindcss: { cssConfigPath } },
  //     rules: { "tailwindcss/no-arbitrary-value": "error" } }
  //
  // Verified: the plugin resolves this project's Tailwind v4 CSS-first config
  // (src/index.css, with its @import chain) without error.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { tailwindcss },
    settings: { tailwindcss: { cssConfigPath } },
    rules: {},
  },

  // =========================================================================
  // ALLOWLIST — content-derived layout / device measurements only. Each entry
  // states WHY. Keep this SHORT (~12). If it has to grow, the component
  // mapping is wrong (§7.3) — flag it in the task report, don't expand here.
  // =========================================================================

  // (A) Inline `style` strings that carry a `calc(... env(safe-area-inset-*))`
  //     expression — iOS notch / home-indicator geometry. No Tailwind utility,
  //     no token: a runtime device measurement, not a design value. Colour and
  //     arbitrary-value bans stay ACTIVE on these files.
  {
    files: [
      "src/pages/CartPage.tsx",
      "src/pages/CheckoutPage.tsx",
      "src/pages/InstantBuyPage.tsx",
      "src/pages/ProductPage.tsx",
    ],
    rules: { "no-restricted-syntax": ["error", ...arbitrarySelectors, ...colorSelectors] },
  },

  // (B) Six className arbitrary values that are content-derived layout or a
  //     sub-scale label size with no token yet. Colour + inline-style bans stay
  //     ACTIVE; only the px-in-arbitrary-value check is relaxed, per file:
  //
  //   src/pages/TicketDetailPage.tsx  grid-cols-[1fr_320px] — fluid main pane +
  //       fixed 320px ticket side-rail; a content decision, no token expresses it.
  //   src/components/shop/Spinner.tsx  align-[-2px] — optical baseline nudge for
  //       the inline spinner glyph; Tailwind has no negative vertical-align util.
  //   src/components/shop/EmptyState.tsx  min-h-[360px] / min-h-[420px] —
  //       illustration panel min-heights. TODO(task-7x): tokenise on migration.
  //   src/components/layout/MobileDrawer.tsx  text-[15px] — drawer nav-row label
  //       size between text-sm (14) and text-base (16). Moved here from
  //       Layout.tsx by the Task 5 chrome split. TODO(task-7x): type-scale token.
  //   src/components/shop/StepTimeline.tsx  text-[11px] — step-number badge.
  //       TODO(task-7x): add a type-scale token.
  //   src/components/shop/TicketMessageThread.tsx  text-[11px] — avatar initials.
  //       TODO(task-7x): add a type-scale token.
  {
    files: [
      "src/pages/TicketDetailPage.tsx",
      "src/components/shop/Spinner.tsx",
      "src/components/shop/EmptyState.tsx",
      "src/components/layout/MobileDrawer.tsx",
      "src/components/shop/StepTimeline.tsx",
      "src/components/shop/TicketMessageThread.tsx",
    ],
    rules: { "no-restricted-syntax": ["error", ...colorSelectors, ...inlineLenSelectors] },
  },
);
