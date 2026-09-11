# Product/Variant Detection Engine — Task Plan (SDD format)

Companion task-formatted plan for `superpowers:subagent-driven-development`.
Architecture rationale, business decisions, and full context: see
`C:\Users\ilham\.claude\plans\joyful-wishing-meadow.md` (approved plan) —
each task below references it for "why", but each task is self-contained for
"what"/"how" so an implementer subagent never needs to read that file.

All work happens in this worktree: `C:\Users\ilham\Documents\web-and-bot-order\.claude\worktrees\detection-engine`
(branch `worktree-detection-engine`). Never touch the main checkout.

## Global Constraints (copy verbatim into every reviewer dispatch)

- **Engine purity (INV-5):** `packages/core/src/detection/**` must never import
  `@prisma/client`, `@app/db`, or perform any I/O (network, filesystem,
  `Date.now()`, `Math.random()`). All data comes in as function parameters
  (`deps: { knowledge, index }`), injected by the caller.
- **No product names in engine code (AC-01):** literal product/game/brand
  names may appear ONLY inside `packages/core/src/detection/knowledge/**` and
  `packages/core/src/detection/__fixtures__/**`. Every other file under
  `detection/` is pure logic with zero product-specific branches.
- **Determinism (INV-1):** no `Date.now()`, `Math.random()`, iteration over a
  `Set`/`Map` whose order affects output, or `localeCompare`. Every sort/tie-
  break is explicit lexicographic string comparison (`a < b`).
- **Non-destructive normalization (INV-2):** normalization may only change
  casing/whitespace/separators/unicode-folding. It must never delete a token,
  strip digits, stem, or truncate a suffix.
- **Total function (INV-3):** every exported function in `detection/` must
  accept `unknown` at its outer boundary and never throw — return a typed
  "unknown"/error-shaped result instead, for any input including `null`,
  `undefined`, `""`, emoji, a 10,000-char string, a number, or an object with
  foreign fields.
- **Money:** if any code path touches price/cost, use `Decimal` from
  `@app/core/money` — never `float`/`number` for money. (Detection tasks
  below do not touch money directly, but denomination-adjacent code must
  still follow this if it appears.)
- **No raw SQL in routes/handlers** — DB access goes through
  `packages/db/src/crud/*` helpers, colocated Vitest tests (`*.test.ts`).
- **Audit every admin-triggered state change** via `logAdminAction` (see
  `packages/db/src/crud/settings.ts` or `packages/db/src/crud/games.ts` for
  the calling convention).
- **Test commands:** typecheck = `pnpm -r typecheck && npx tsc -p tsconfig.test.json`
  (run from repo root of the worktree). Test = `npx vitest run <scoped-path>`
  for iteration, full `pnpm test` before declaring a task DONE. Do not run
  `pnpm test` (full ~6600-test suite, ~10 min) more than once per task —
  scope your iteration runs to the files you touched.
- **Existing tests are sacred until Task 13:** do not modify
  `packages/core/src/suppliers/digiflazz.test.ts` or
  `packages/db/src/crud/digiflazz.test.ts` in Tasks 1-11. They must stay
  green, untouched, throughout.
- **Commit as you go** per this repo's normal convention (Conventional-ish,
  imperative, no attribution trailer needed inside the worktree — the
  controller squashes/finalizes trailers at merge time).

---

## Task 1: Detection engine scaffolding — types, version, knowledge shape

Create the foundational types and the Knowledge layer's default vocabulary,
with zero behavior yet. This unblocks every later task.

**Files to create:**

- `packages/core/src/detection/types.ts` — all shared types:

  ```ts
  export interface Evidence { signal: string; value: string; weight: number }
  export interface Conflict {
    losingSignal: string;
    winningSignal: string;
    winningLevel: number;
    reason: string;
  }
  export interface Candidate {
    baseProductKey: string;
    productKey: string;
    score: number;
    evidence: Evidence[];
  }
  export interface DetectionAttributes {
    platform: string | null;
    edition: string | null;
    distribution: string | null;
    region: string | null;
    publisher: string | null;
  }
  export type DetectionResult =
    | {
        status: "resolved";
        baseProductKey: string;
        productKey: string;
        skuKey: string | null;
        attributes: DetectionAttributes;
        confidence: number;
        score: number;
        evidence: Evidence[];
        conflicts: Conflict[];
        detectorVersion: string;
      }
    | {
        status: "ambiguous";
        candidates: Candidate[];
        reason: string;
        evidence: Evidence[];
        detectorVersion: string;
      }
    | {
        status: "unknown";
        reason: string;
        evidence: Evidence[];
        detectorVersion: string;
      };

  /** Raw input to detect() — deliberately loose; detect() must coerce, never throw. */
  export interface DetectionInput {
    productName?: string | null;
    externalId?: string | null;
    category?: string | null;
    type?: string | null;
    country?: string | null;
    variant?: string | null;
    publisher?: string | null;
  }

  export type TokenCategory =
    | "platform"
    | "distribution"
    | "region"
    | "edition"
    | "denomination"
    | "noise";

  export interface KnowledgeToken {
    category: TokenCategory;
    token: string; // already normalized
    canonical: string;
    isProductDefining: boolean;
    enabled: boolean;
  }
  export interface KnowledgeAlias {
    alias: string; // normalized
    expandsTo: string; // normalized
    reason: string | null;
  }
  export interface KnowledgeOverride {
    matchKind: "normalized_name" | "external_id";
    matchValue: string;
    baseProductKey: string;
    productKey: string;
    reason: string;
  }
  export interface KnowledgeBase {
    tokens: readonly KnowledgeToken[];
    aliases: readonly KnowledgeAlias[];
    overrides: readonly KnowledgeOverride[];
    /** External-id stability flag per supplier — level-2 signal only applies when true. */
    externalIdStableBySupplier: Readonly<Record<string, boolean>>;
    revision: string;
  }

  export interface CatalogEntry {
    externalId: string | null;
    productName: string;
    category: string | null;
    type: string | null;
    /** Opaque id the caller uses to map a result back to its own record. */
    refId: string;
  }
  ```

- `packages/core/src/detection/version.ts`:

  ```ts
  export const DETECTOR_VERSION = "1.0.0";
  export function buildDetectorStamp(knowledgeRevision: string): string {
    return `${DETECTOR_VERSION}+k${knowledgeRevision}`;
  }
  ```

  Bump `DETECTOR_VERSION` (semver-ish, manual) whenever engine logic changes
  in a way that could change a `productKey`/`skuKey` for existing input.

- `packages/core/src/detection/knowledge/schema.ts` — zod validator for
  `KnowledgeBase` (import `zod`, already a dependency of `@app/core`). Export
  `knowledgeBaseSchema: z.ZodType<KnowledgeBase>` (or equivalent) that
  validates the full shape including nested arrays. This is what the DB
  loader (a later task) uses to reject invalid data loudly instead of
  silently degrading.

- `packages/core/src/detection/knowledge/defaultVocabulary.ts` — the
  **fallback/seed/test-fixture** vocabulary. This is the ONE place besides
  `__fixtures__/` where literal words are allowed. Populate it with a small,
  honest starting vocabulary grounded in what Digiflazz's real category
  vocabulary looks like (generic gaming/top-up terms — do NOT invent brand
  names here, this is genuinely generic vocabulary):
  - `platform` tokens: `mobile`→`mobile`, `pc`→`pc`, `console`→`console` (all `isProductDefining: true`)
  - `edition` tokens: `max`→`max`, `lite`→`lite`, `pro`→`pro`, `plus`→`plus` (all `isProductDefining: true`)
  - `distribution` tokens: `garena`→`garena`, `global`→`global` (`isProductDefining: true` — per the plan's D-decision that distributor CAN be product-defining when it changes the actual account/client, which is a data decision, not hardcoded)
  - `region` tokens: `id`→`id`, `sg`→`sg`, `my`→`my` (`isProductDefining: false` — distribution-only per §3 of the spec)
  - `noise` tokens (things that look like a parenthetical suffix but aren't a region — ported from the existing denylist in `packages/core/src/suppliers/digiflazz.ts:180-186`, which stays untouched until Task 13): `instant`→`instant`, `proses cepat`→`proses cepat` (`isProductDefining: false`, `enabled: true`)
  - Export `DEFAULT_KNOWLEDGE_BASE: KnowledgeBase` assembling all of the
    above with `revision: "default"` and `externalIdStableBySupplier: { digiflazz: true }` (grounded in the audit finding that `buyerSkuCode` is genuinely the resync key for Digiflazz today — see `packages/db/src/crud/digiflazz.ts:843-849`).

**Out of scope:** no normalization/tokenization/scoring logic yet — this task
is pure type/data scaffolding. `defaultVocabulary.ts` is data, not consumed
by anything yet.

**Tests required:**
- `packages/core/src/detection/knowledge/schema.test.ts` — validates
  `DEFAULT_KNOWLEDGE_BASE` passes the zod schema; validates a handful of
  deliberately malformed objects (missing field, wrong type, duplicate
  `[category, token]`) are rejected with a clear error, not silently coerced.

**Done when:** `npx tsc -p tsconfig.test.json` and
`npx vitest run packages/core/src/detection` are green. No other package is
touched.

---

## Task 2: normalize.ts + tokenize.ts

**Depends on:** Task 1 types.

**Files to create:**

- `packages/core/src/detection/normalize.ts`:

  ```ts
  export function normalize(input: unknown): string;
  ```

  Coerces any input to a normalized string per the Global Constraints'
  non-destructive rule: lowercase, trim, collapse internal whitespace runs to
  one space, map separators `-`, `_`, `.`, `:` to a single space, Unicode
  NFKD-normalize and strip combining diacritical marks (`\p{Mn}` via regex
  with the `u` flag), map full-width characters to half-width (use
  `String.prototype.normalize("NFKC")` for the full-width→half-width part
  specifically — do this BEFORE the diacritic-stripping NFKD pass, since NFKD
  would otherwise interact with NFKC-only mappings). Non-string input
  (`null`, `undefined`, number, object, etc.) coerces to `""`. Do not strip
  digits, do not remove any token, do not stem.

- `packages/core/src/detection/tokenize.ts`:

  ```ts
  export function tokenize(normalized: string): string[];
  ```

  Splits an already-normalized string on whitespace, filtering empty
  entries. Also export:

  ```ts
  export function despace(normalized: string): string;
  ```

  Returns the normalized string with ALL whitespace removed (used later for
  the `"PUBGMobile"` despaced-key lookup per AC-05 — do not implement that
  lookup here, just provide this primitive).

**Tests required (colocated `.test.ts` per file):**
- `normalize.test.ts`: casing, trim, multi-space collapse, each separator
  type, a diacritic example (`"É"` → `"e"`), a full-width example
  (`"ＡＢＣ"` → `"abc"`), non-string inputs (`null`, `undefined`, `42`,
  `{}`, `[]`) all return `""` without throwing. **Property test** (via
  `fast-check`, `fc.string()` arbitrary, run at least 100 cases): every digit
  character present in the input string is also present in
  `normalize(input)` (INV-2 — normalization never drops digits); every
  whitespace-separated "word" made only of non-separator characters that
  appears in the input also appears, case/diacritic-folded, as a token in
  `tokenize(normalize(input))` — state this precisely as: token count of
  `tokenize(normalize(s))` is monotonic non-decreasing as separator noise is
  added around an existing token (pick a concrete, checkable invariant here
  rather than an vague one — write it, then verify it actually holds before
  committing).
- `tokenize.test.ts`: empty string → `[]`, single word, multiple words,
  leading/trailing whitespace already stripped by `normalize` (test
  `tokenize` on already-normalized input, not raw input — it's a separate
  unit). `despace`: `"pubg mobile"` → `"pubgmobile"`.

**Done when:** typecheck + `npx vitest run packages/core/src/detection` green.

---

## Task 3: features.ts + keys.ts

**Depends on:** Tasks 1-2.

**Files to create:**

- `packages/core/src/detection/features.ts`:

  ```ts
  export interface ExtractedFeatures {
    coreTokens: string[];           // non-category tokens, in original order
    definingTokens: { category: TokenCategory; canonical: string }[];
    distributionTokens: { category: TokenCategory; canonical: string }[];
    parentheticalSuffix: string | null; // raw suffix e.g. "Indonesia" — null if absent or denylisted noise
  }
  export function extractFeatures(
    normalizedName: string,
    knowledge: KnowledgeBase,
  ): ExtractedFeatures;
  ```

  Behavior:
  1. Apply every enabled `KnowledgeAlias` first: if the FULL normalized name
     (or the despaced form) matches an alias, expand it before tokenizing
     (e.g. `"mlbb"` → `"mobile legends bang bang"`).
  2. Tokenize the (possibly alias-expanded) name.
  3. Classify each token against `knowledge.tokens` (matched by
     `[category, token]`, only `enabled: true` entries). A token matching a
     `noise` category is dropped entirely from `coreTokens` and, if it was
     the trailing parenthetical, recorded in `parentheticalSuffix` logic
     (see below) as suppressed (`parentheticalSuffix: null`).
  4. Tokens matching a non-`noise` category go to `definingTokens` (if
     `isProductDefining: true`) or `distributionTokens` (if `false`); they
     are REMOVED from `coreTokens` either way — `coreTokens` is what's left
     after every classified token is stripped, i.e. the "core name" tokens
     the level-3 signal (Task 4) matches against.
  5. `parentheticalSuffix`: detect a trailing `(...)` group in the
     ORIGINAL (pre-alias-expansion) normalized string before tokenizing it
     away (mirroring `parseProductRegion`'s regex intent from
     `packages/core/src/suppliers/digiflazz.ts:170-190`, reimplemented here
     as pure knowledge-driven logic — do NOT import that file). If the
     captured group's normalized text matches a `noise`-category token in
     `knowledge.tokens`, or matches the duration-range shape (`/^\d+-\d+\s*(menit|jam|hari)$/`
     — this one structural pattern is the one exception allowed to live in
     code rather than data, since it's a shape not a vocabulary; document
     this exception with a one-line comment), return `parentheticalSuffix: null`.
     Otherwise return the captured text (normalized) as `parentheticalSuffix`
     and also classify it via step 3 if it matches a `region`/`edition`/etc.
     token.

- `packages/core/src/detection/keys.ts`:

  ```ts
  export function buildBaseProductKey(coreTokens: string[]): string;
  export function buildProductKey(
    baseProductKey: string,
    definingTokens: { category: TokenCategory; canonical: string }[],
  ): string;
  export function buildSkuKey(
    productKey: string,
    denomination: string | null,
    distributionTokens: { category: TokenCategory; canonical: string }[],
  ): string;
  ```

  Serialization rules (must be deterministic — INV-1, INV-4):
  - `baseProductKey` = `coreTokens.join(" ")` (already normalized/ordered —
    do NOT sort core tokens, word order is meaningful for the base name).
  - `productKey` = `` `${baseProductKey}::${sortedDefiningPairs}` `` where
    `sortedDefiningPairs` is `definingTokens` deduplicated by
    `[category, canonical]`, sorted **lexicographically by the string**
    `` `${category}=${canonical}` `` (explicit `Array.prototype.sort` with a
    plain `<`/`>` comparator — never `localeCompare`), then joined with `,`.
    If `definingTokens` is empty, `productKey === baseProductKey` (no `::`
    suffix — this is what makes AC-04's "same product, different
    distribution" case collapse cleanly).
  - `skuKey` = `` `${productKey}::denom=${denomination normalized or "none"}${sortedDistributionSuffix}` ``
    with the same sorted/joined convention for `distributionTokens`.

**Tests required:**
- `features.test.ts`: alias expansion, each token category classification,
  parenthetical region vs. denylisted-noise vs. duration-pattern, a case
  with no parenthetical at all.
- `keys.test.ts` — **INV-4 focus**: build keys from the same logical input
  with `definingTokens`/`distributionTokens` arrays in different orders
  (e.g. `[platform, edition]` vs `[edition, platform]`) and assert the
  resulting `productKey`/`skuKey` strings are byte-identical. Also assert
  two DIFFERENT sets of defining tokens never collide by construction (spot
  test, not exhaustive).

**Done when:** typecheck + `npx vitest run packages/core/src/detection` green.

---

## Task 4: scoring.ts

**Depends on:** Tasks 1-3 (uses `KnowledgeBase`/`TokenCategory` types; does
not need `features.ts`'s implementation, only its output shape).

**File to create:** `packages/core/src/detection/scoring.ts`.

Export named integer constants, each with a one-line comment stating the
reason (copy the rationale, don't just restate the number):

```ts
export const W_OVERRIDE = 100;              // short-circuit: beats the sum of every other band combined
export const W_EXTERNAL_ID = 60;            // level 2 — only applied when knowledge.externalIdStableBySupplier[supplier] is true
export const W_NAME_CORE = 40;              // level 3 — equals ACCEPT_THRESHOLD: a full core-name match is sufficient alone
export const W_NAME_CORE_DESPACED = 25;     // level 3 (weak) — below ACCEPT_THRESHOLD by construction, see AC-05
export const W_DEFINING_TOKEN = 10;         // level 3, per matched product-defining token
export const DEFINING_TOKEN_CAP = 30;       // at most 3 defining tokens counted, so a long name can't win on length alone
export const W_STRUCTURED_META = 15;        // level 4 — category/type metadata, coarse
export const W_DISTRIBUTION = 5;            // level 5, per distribution signal (publisher/country/admin-set variant)
export const DISTRIBUTION_CAP = 10;         // level 5 total cap — tie-breaker only
export const ACCEPT_THRESHOLD = 40;         // == W_NAME_CORE: name match alone must be enough
export const MARGIN = 15;                   // > DISTRIBUTION_CAP: two candidates can never split on distribution evidence alone
```

Export:

```ts
export interface ScoredCandidate {
  baseProductKey: string;
  productKey: string;
  score: number;
  maxAttainableScore: number;
  evidence: Evidence[];
}
export function computeConfidence(score: number, maxAttainableScore: number): number;
// = Math.round((score / maxAttainableScore) * 100) / 100, guard maxAttainableScore === 0 -> 0
```

**Tests required (`scoring.test.ts`) — this is the AC-02 enforcement point:**
- `expect(W_STRUCTURED_META + DISTRIBUTION_CAP).toBeLessThan(ACCEPT_THRESHOLD)`
  — asserted directly against the exported constants, not a re-derived
  number, so a future edit to any of the three constants re-triggers this
  check.
- `expect(MARGIN).toBeGreaterThan(DISTRIBUTION_CAP)`.
- `computeConfidence` returns a value in `[0, 1]` rounded to 2 decimals for
  a table of (score, maxAttainableScore) pairs including `maxAttainableScore
  === 0` (must return `0`, not `NaN`/`Infinity`).
- No floating-point weight anywhere — grep-assertable: all exported
  constants are integers (`Number.isInteger`).

**Done when:** typecheck + `npx vitest run packages/core/src/detection` green.

---

## Task 5: indexBuild.ts + engine.ts + invariant/property/benchmark tests

**Depends on:** Tasks 1-4. This is the largest task — the implementer should
use a standard (not cheap) model given the integration surface.

**Files to create:**

- `packages/core/src/detection/indexBuild.ts`:

  ```ts
  export interface CatalogIndex {
    readonly byProductKey: ReadonlyMap<string, readonly CatalogEntry[]>;
    readonly byBaseKey: ReadonlyMap<string, readonly CatalogEntry[]>;
    readonly byNormalizedName: ReadonlyMap<string, readonly CatalogEntry[]>;
    readonly byDespacedName: ReadonlyMap<string, readonly CatalogEntry[]>;
    readonly byExternalId: ReadonlyMap<string, readonly CatalogEntry[]>;
    readonly stamp: string;
    readonly entryCount: number;
  }
  export function buildCatalogIndex(
    entries: readonly CatalogEntry[],
    knowledge: KnowledgeBase,
    stamp: string,
  ): CatalogIndex;
  ```

  For each entry: normalize its `productName`, run `extractFeatures`, build
  its `baseProductKey`/`productKey` via `keys.ts`, and push it into every
  relevant map bucket (`byNormalizedName` keyed by the normalized name,
  `byDespacedName` keyed by `despace(normalizedName)`, `byExternalId` keyed
  by `entry.externalId` when non-null). **Every bucket array must be sorted
  lexicographically by `productKey` before being frozen into the Map** (INV-1
  — iteration order must never be insertion-order-dependent). Use a plain
  mutable `Map` internally, then expose as `ReadonlyMap`.

- `packages/core/src/detection/engine.ts`:

  ```ts
  export interface DetectionDeps {
    readonly knowledge: KnowledgeBase;
    readonly index: CatalogIndex;
    /** Which supplier this input is from — selects externalIdStableBySupplier flag. Optional; absent = level-2 signal never applies. */
    readonly supplier?: string;
  }
  export function detect(input: unknown, deps: DetectionDeps): DetectionResult;
  ```

  Pipeline: coerce `input` defensively (never destructure without guards —
  every field access goes through a safe helper that returns `null` for
  anything not a non-empty string) → `normalize` the `productName` (empty
  productName after coercion → immediately `unknown` with
  `reason: "no usable product name"`, still including `detectorStamp`/
  `evidence: []`) → check `knowledge.overrides` for an exact match on
  normalized name or `externalId` FIRST (level 1, short-circuit: build the
  result directly from the override's `productKey`/`baseProductKey` with a
  single `evidence` entry `{signal: "override", value: matchValue, weight:
  W_OVERRIDE}` and `status: "resolved"`, `confidence: 1`) → `extractFeatures`
  → look up candidates via `lookupCandidates(deps.index, ...)` (a helper in
  this file or `indexBuild.ts` — at most 5 `Map.get` calls, no scan) →
  score every returned candidate using `scoring.ts` constants, accumulating
  `evidence[]` per candidate → pick the winner and margin vs. runner-up →
  decide `resolved`/`ambiguous`/`unknown` per §4.3 of the architecture plan
  → populate `conflicts[]` whenever a level-4/5 signal pointed at a
  DIFFERENT candidate than the winner (record `{losingSignal, winningSignal,
  winningLevel, reason}`).

  `attributes` in a `resolved` result is populated from
  `definingTokens`/`distributionTokens` (map each present category to its
  canonical value, `null` for absent categories) plus any `country`/
  `variant`/`publisher` fields on the raw `input` folded in ONLY as
  level-5 distribution evidence (never elevate them to level 3/4).

**Tests required:**
- `indexBuild.test.ts`: building an index from a small entry list, asserting
  each bucket contains the right entries and that arrays are sorted by
  `productKey`.
- `engine.invariants.test.ts`:
  - **INV-3** table: `null`, `undefined`, `""`, `42`, `{}`, `[]`,
    `{ productName: 12345 }`, an object with unexpected extra fields, an
    emoji-only string, a 10,000-character string — assert `detect()` never
    throws for any of these and always returns a well-typed
    `DetectionResult` (`status` is one of the three literals).
  - **INV-1** determinism: pick 3 genuinely ambiguous/conflicting inputs
    (see AC-07 scenarios in Task 6) and run `detect()` 1000 times on each
    with the SAME `deps`; `JSON.stringify` every result and assert all 1000
    stringified results for a given input are identical.
  - **AC-06**: every field of `DetectionInput` null one at a time, and all
    null together, and an empty object `{}` — assert no throw and either a
    best-effort `resolved`/`ambiguous` or an `unknown` with a non-empty,
    human-readable `reason` string.
  - **AC-07**: construct 3 concrete conflict scenarios (e.g. a name that
    matches candidate A on core name but whose `country`/`publisher` fields
    match candidate B's distribution profile) and assert `conflicts[]` is
    non-empty, names the winning/losing signals, and that the WINNER is
    always the lower (stronger) ladder level.
- `engine.property.test.ts` (fast-check, **AC-19**): an arbitrary generator
  producing `DetectionInput`-shaped-ish objects with random strings/nulls/
  numbers in each field (use `fc.record` with `fc.oneof(fc.string(),
  fc.constant(null), fc.integer(), fc.constant(undefined))` per field, plus
  a separate `fc.anything()` run for true INV-3 coverage) run for at least
  200 cases: (a) INV-3 — never throws; (b) INV-1 — calling `detect` twice on
  a deep-cloned identical input yields identical stringified output.
- `benchmark.test.ts` (**AC-13**): build a `CatalogIndex` from 10,000
  synthetic `CatalogEntry` rows (generate procedurally — e.g. `Game
  ${i}`/`Game ${i} Mobile` patterns, NOT hand-written), time 1,000 `detect()`
  calls against that index, assert total time is under a documented budget
  (pick 2000ms for 1,000 calls as the initial budget — document why in a
  comment: generous enough to not flake on a loaded CI runner, tight enough
  to catch an accidental O(n) scan against a 10k-entry index). Also assert
  structurally: `deps.index.byProductKey instanceof Map` (or check it's not
  a plain object doing `Object.keys` scans) as a second, independent
  guarantee against the benchmark alone being gameable.

**Done when:** typecheck + `npx vitest run packages/core/src/detection` green,
including the property and benchmark suites.

---

## Task 6: Synthetic fixtures + acceptance tests (AC-03/04/05/08/09/11)

**Depends on:** Task 5 (needs a working `detect()` + index).

**Files to create:**

- `packages/core/src/detection/__fixtures__/syntheticGameA.ts` — exports a
  `SYNTHETIC_CATALOG: CatalogEntry[]` and a `SYNTHETIC_KNOWLEDGE:
  KnowledgeBase` (extending `DEFAULT_KNOWLEDGE_BASE` with any tokens needed
  for these names — e.g. `garena` and `pc`/`mobile`/`global` should already
  exist from Task 1's default vocabulary; add only what's missing) covering
  **at minimum**: `"Game A"`, `"Game A Mobile"`, `"Game A Global"`,
  `"Game A Garena"`, `"Game A PC"` as distinct catalog rows, each with a
  distinct `externalId`. This is the AC-11 fixture — these five names must
  never have appeared anywhere in the engine or knowledge files before this
  task.
- Also add fixture rows for the spec's 7-entity AC-03 example set
  (`"Delta Force"`, `"Delta Force Garena"`, `"Free Fire"`, `"Free Fire MAX"`,
  `"PUBG Mobile"`, `"PUBG Lite"`, `"PUBG PC"`) — these ARE explicitly named
  in the spec as the acceptance example, so they belong here, not treated as
  "real catalog data" (they aren't — the audit confirmed the real Digiflazz
  catalog has none of these exact names patterned this way). Add the
  knowledge tokens these need (`max` edition already exists from Task 1).
- `packages/core/src/detection/engine.acceptance.test.ts`:
  - **AC-03**: run `detect()` on the 7-entity set (as raw `productName`
    input, no catalog lookup needed if they resolve purely from
    name+knowledge — or against a built index if candidate lookup is
    required for your design) and assert the resulting `productKey` set has
    exactly 7 distinct members.
  - **AC-04**: pick ONE product from the fixture, construct 3 input variants
    that differ only in `country`, only in `publisher`, and only in
    denomination/SKU respectively (same core name) — assert all 3 produce
    the SAME `productKey` and, when denomination differs, different
    `skuKey`.
  - **AC-05**: run `detect()` (or `normalize`+`extractFeatures`+`keys`) on
    `"PUBG Mobile"`, `"pubg mobile"`, `" PUBG Mobile "`, `"PUBG-Mobile"`,
    `"PUBG_Mobile"`, `"PUBG  Mobile"` and assert identical `productKey`
    across all 6. Then run on `"PUBGMobile"` and assert
    `status === "ambiguous"` (NOT `"resolved"`) per the architecture
    decision — document this assertion with a one-line comment citing AC-05.
    Then add a `KnowledgeAlias { alias: "pubgmobile", expandsTo: "pubg
    mobile" }` to a knowledge variant used only in this one test and assert
    it now resolves — this is the "fixed via data, not code" proof.
  - **AC-08**: an input with only a weak/ambiguous signal (e.g. only a
    `category` field, no name) → assert `status` is `"ambiguous"` or
    `"unknown"`, and if `"ambiguous"`, assert every candidate's implied
    confidence is `<= 0.5`.
  - **AC-09**: for every fixture entry that resolves, assert
    `result.evidence.length > 0` and each evidence entry has non-empty
    `signal`/`value` and a numeric `weight`.
- `packages/core/src/detection/engine.synthetic.test.ts`: run `detect()`
  against all 5 "Game A..." variants and assert 5 distinct `productKey`s,
  each `status: "resolved"`.

**Verification step (part of this task, not optional):** after committing,
run `git diff --stat` against the base commit of this task, filtered to
exclude `knowledge/` and `__fixtures__/`:
`git diff --stat <task-base-commit> -- packages/core/src/detection ':!packages/core/src/detection/knowledge' ':!packages/core/src/detection/**/__fixtures__'`
— this MUST print nothing (empty diff). Paste this command and its (empty)
output into your self-review / final report as the AC-11 proof.

**Done when:** typecheck + `npx vitest run packages/core/src/detection`
green, AND the git-diff proof above is captured in the report.

---

## Task 7: check-detection-engine-purity.ts → pretest (AC-01)

**Depends on:** Task 1 (needs `detection/` to exist; can run any time after,
but logically follows once there's real content to check).

**File to create:** `scripts/check-detection-engine-purity.ts` (mirror the
style of existing checkers, e.g. `scripts/check-frontend-boundaries.ts` or
`scripts/check-migration-drift.ts` — read one for CLI/exit-code conventions
before writing this one).

Behavior:
1. Glob every `.ts` file under `packages/core/src/detection/`, EXCLUDING
   `packages/core/src/detection/knowledge/**` and
   `packages/core/src/detection/__fixtures__/**` and any `*.test.ts` file.
2. For each remaining file, reject (non-zero exit, print file+line) any
   occurrence of:
   - `localeCompare` (enforces the lexicographic tie-break rule)
   - `Date.now(` or `new Date(` with no arguments, `Math.random(`
   - an import from `@prisma/client` or `@app/db`
3. **Derive the product-name denylist from data, not a hardcoded list in the
   script** (per the plan's explicit requirement that this checker "menurunkan
   denylist-nya dari data knowledge" so it can't go stale): load
   `DEFAULT_KNOWLEDGE_BASE` from `knowledge/defaultVocabulary.ts` plus every
   fixture file's exported catalog/knowledge constants under
   `__fixtures__/`, collect every literal token/canonical/alias/productName
   string that's NOT a generic category word already present in
   `defaultVocabulary.ts`'s platform/edition/region/noise lists — actually,
   simpler and more robust: collect the set of PRODUCT-SPECIFIC proper nouns
   that appear in `__fixtures__/*.ts` (e.g. `"Game A"`, `"Delta Force"`,
   `"Free Fire"`, `"PUBG"`, ...) by reading those files' string literals
   directly, then grep every non-excluded `detection/` file for a
   case-insensitive match of any of those tokens. Flag (exit 1) any match.
   This makes the check self-maintaining: adding a new synthetic fixture
   automatically extends what the checker looks for, with zero manual
   updates to the checker itself.
4. Exit 0 with a short success line when clean.

**Wire it in:** add `&& pnpm run check-detection-engine-purity` to the end
of the root `package.json`'s `pretest` script (find the existing chain and
append), and add a `"check-detection-engine-purity": "tsx
scripts/check-detection-engine-purity.ts"` entry to `scripts` in root
`package.json` (match the existing `tsx scripts/...` pattern used by sibling
checkers).

**Tests required:** `scripts/check-detection-engine-purity.test.ts` (there
is precedent for checker scripts having tests — check if
`check-frontend-boundaries.ts` has one and follow that pattern; if none of
the existing checkers have tests, write one anyway here since this one's
logic is non-trivial): a passing-fixture temp dir and a deliberately-
violating temp dir (e.g. a fake file containing `"Free Fire"` outside
`knowledge/`), asserting the script's exit code / return value differs
correctly. If the script is structured as `main()` plus an exported pure
`checkFile(content, bannedTokens): Violation[]` function, test the pure
function directly instead of shelling out — prefer that structure.

**Done when:** `pnpm run check-detection-engine-purity` exits 0 against the
current (clean) `detection/` tree, and exits non-zero against a deliberately
seeded violation (verify this manually during self-review, then revert the
seeded violation before committing). `pnpm run pretest` — **do not run the
FULL pretest chain if it's slow (it lints the storefront client too)**;
instead just verify your one new line was appended correctly by reading the
`package.json` diff, and run the new script directly.

---

## Task 8: Prisma migration + detectionKnowledge.ts + detectionIndex.ts + seed script

**Depends on:** Task 1 (types), Task 5 (index shape). This task is
integration-heavy (Prisma migration correctness, cache pattern matching) —
use a standard model, not the cheap tier.

**Schema changes** (`prisma/schema.prisma`):

Add 4 new models (place near the end of the file, after the last model,
matching this repo's existing model-comment style — every field that isn't
self-explanatory gets a `///` doc comment, see any existing model for the
convention):

```prisma
model DetectionToken {
  id                Int     @id @default(autoincrement())
  category          String
  token             String
  canonical         String
  isProductDefining Boolean @map("is_product_defining")
  enabled           Boolean @default(true)
  @@unique([category, token], map: "ix_detection_tokens_category_token")
  @@map("detection_tokens")
}

model DetectionAlias {
  id        Int     @id @default(autoincrement())
  alias     String  @unique(map: "ix_detection_aliases_alias")
  expandsTo String  @map("expands_to")
  reason    String?
  @@map("detection_aliases")
}

model DetectionOverride {
  id             Int      @id @default(autoincrement())
  matchKind      String   @map("match_kind")
  matchValue     String   @map("match_value")
  productKey     String   @map("product_key")
  baseProductKey String   @map("base_product_key")
  reason         String
  createdBy      Int?     @map("created_by")
  createdAt      DateTime @default(now()) @map("created_at")
  hitCount       Int      @default(0) @map("hit_count")
  @@unique([matchKind, matchValue], map: "ix_detection_overrides_match")
  @@map("detection_overrides")
}

model DetectionIssue {
  id               Int      @id @default(autoincrement())
  status           String
  reviewStatus     String   @default("OPEN") @map("review_status")
  inputFingerprint String   @unique(map: "ix_detection_issues_fingerprint") @map("input_fingerprint")
  rawInput         String   @map("raw_input")
  reason           String
  candidates       String?
  detectorStamp    String   @map("detector_stamp")
  occurrences      Int      @default(1)
  firstSeenAt      DateTime @default(now()) @map("first_seen_at")
  lastSeenAt       DateTime @updatedAt @map("last_seen_at")
  @@index([reviewStatus, lastSeenAt], map: "ix_detection_issues_status_seen")
  @@map("detection_issues")
}
```

Add nullable columns to `Product` (after `gameId`, before the closing
relations block — check current line numbers with `Read` first, they will
have shifted since the audit):

```prisma
detectionBaseProductKey String?  @map("detection_base_product_key")
detectionProductKey     String?  @map("detection_product_key")
detectionStatus         String?  @map("detection_status")
detectionConfidence     Decimal? @map("detection_confidence")
detectionStamp          String?  @map("detection_stamp")
```

and to `Denomination`:

```prisma
detectionSkuKey String? @map("detection_sku_key")
detectionStamp  String? @map("detection_stamp")
```

Add indexes: `@@index([detectionProductKey], map: "ix_products_detection_product_key")`
on `Product`, `@@index([detectionSkuKey], map: "ix_denominations_detection_sku_key")`
on `Denomination`.

**Generate the migration** using this repo's normal flow — check
`prisma/migrations/` for the naming convention of the most recent migration
directory and follow it exactly (timestamp format matters —
`check-migration-timestamps` enforces it). Use
`pnpm exec prisma migrate dev --name add_detection_engine --create-only`
against a working dev Postgres if available in this worktree's `.env`
(`DATABASE_URL_PRISMA`) to generate correct SQL, then hand-review the
generated SQL file for exact correctness before applying. If no dev Postgres
is reachable from this worktree, write the migration SQL by hand following
the most recent existing migration file as a template, and flag this in
your report as `DONE_WITH_CONCERNS` so the controller can verify it against
a real DB before this is trusted.

Run `pnpm run check-migration-drift`, `pnpm run check-migration-timestamps`,
`pnpm run check-migration-rebuild-quoting` (see root `package.json`
`pretest` line for exact script names) and confirm all three pass against
your new migration.

**`packages/core/package.json`:** add to `exports`:
```json
"./detection": "./src/detection/index.ts",
"./detection/knowledge": "./src/detection/knowledge/defaultVocabulary.ts"
```
(Create `packages/core/src/detection/index.ts` as a barrel re-exporting
everything from Tasks 1-6 if it doesn't already exist from an earlier task —
check first.)

**Files to create in `packages/db/src/crud/`:**

- `detectionKnowledge.ts`:
  ```ts
  export async function loadKnowledgeBase(db: Db): Promise<KnowledgeBase>;
  export async function upsertDetectionToken(db: Db, args: {...}, adminId: number): Promise<void>;
  export async function upsertDetectionAlias(db: Db, args: {...}, adminId: number): Promise<void>;
  export async function upsertDetectionOverride(db: Db, args: {...}, adminId: number): Promise<void>;
  export function __clearDetectionKnowledgeCacheForTests(db: Db): void;
  ```
  Read `packages/db/src/crud/settings.ts` lines ~17-28 FIRST (the WeakMap +
  TTL cache pattern) and copy that exact pattern, scoped per-`Db` instance,
  30s TTL. `loadKnowledgeBase` reads all three tables, validates the merged
  result against `knowledgeBaseSchema` from Task 1 (throw with a specific
  message naming which row/field failed — never silently drop bad rows), and
  falls back to `DEFAULT_KNOWLEDGE_BASE` ONLY when all three tables are
  completely empty (first-run / fresh install case) — merge rule when the
  tables have SOME rows: DB rows are the full picture for `tokens`/`aliases`/
  `overrides` (DB fully replaces default for populated categories — do not
  silently blend), but always union with the vocabulary's `noise`-category
  entries so the seed script (below) is expected to have copied
  `DEFAULT_KNOWLEDGE_BASE`'s rows into the DB on first run rather than the
  loader doing the merging live. Every upsert function calls `logAdminAction`
  (check `packages/db/src/crud/games.ts` for the exact call signature/
  convention) and bumps a `Settings` key `detection_knowledge_revision`
  (reuse `getSetting`/`setSetting` from `crud/settings.ts` — do not
  reinvent).

- `detectionIndex.ts`:
  ```ts
  export async function getCatalogIndex(db: Db): Promise<CatalogIndex>;
  export async function bumpCatalogRevision(db: Db): Promise<void>;
  export function __clearDetectionIndexCacheForTests(db: Db): void;
  ```
  `getCatalogIndex` fetches `CatalogEntry[]` from `Product`+`Denomination`
  (every Product with a non-null `digiflazzBrand`, mapped to
  `{ externalId: null, productName: product.name, category: null, type:
  null, refId: String(product.id) }` for now — this task does not need to be
  exhaustive about what counts as a catalog row, just correct and testable;
  a later task refines the source), calls `buildCatalogIndex` from
  `packages/core`, and caches with the SAME WeakMap+TTL(30s)+revision-
  counter pattern as above, keyed off a `Settings` value
  `detection_catalog_revision` (bump via `bumpCatalogRevision`, called by
  any future catalog-mutating crud function — this task just provides the
  primitive, wiring callers happens in Task 9/10).

**File to create:** `scripts/seed-detection-knowledge.ts` — idempotent:
for each entry in `DEFAULT_KNOWLEDGE_BASE.tokens`/`.aliases`, upsert into the
DB (unique constraint means re-running is a no-op after the first run). Add
a `"seed-detection-knowledge": "tsx scripts/seed-detection-knowledge.ts"`
entry to root `package.json` `scripts`.

**Tests required:**
- `packages/db/src/crud/detectionKnowledge.test.ts`: loader returns default
  when tables empty; loader returns DB rows when populated; cache
  invalidates on TTL and on explicit `__clearDetectionKnowledgeCacheForTests`;
  invalid DB row throws with a specific message (not silent `null`); upsert
  functions call `logAdminAction` (assert via the audit-log crud helper, same
  pattern other crud tests use to assert audit entries — check
  `packages/db/src/crud/games.test.ts` for the pattern).
- `packages/db/src/crud/detectionIndex.test.ts`: index reflects seeded
  Products; cache invalidates when `bumpCatalogRevision` is called.

**Done when:** `pnpm -r typecheck` green (Prisma client regenerates
correctly — run `pnpm exec prisma generate --schema prisma/schema.prisma`
after editing the schema, before typechecking), the 3 migration-check
scripts pass, and
`npx vitest run packages/db/src/crud/detectionKnowledge.test.ts packages/db/src/crud/detectionIndex.test.ts packages/core/src/detection`
is green.

---

## Task 9: detectionRun.ts + detectionIssues.ts + endpoints + admin panel (AC-16/AC-20)

**Depends on:** Task 8.

**Files to create in `packages/db/src/crud/`:**

- `detectionRun.ts`:
  ```ts
  export async function runDetectionForCatalog(db: Db): Promise<DetectionRunSummary>;
  export async function getLatestDetectionRunStatus(db: Db): Promise<DetectionRunSummary | null>;
  ```
  `DetectionRunSummary` shape: `{ detectorStamp, totalRecords, resolved,
  ambiguous, unknown, confidenceBuckets: Record<string, number>,
  overrideHits, finishedAt }`. Read
  `packages/db/src/crud/digiflazzSyncStatus.ts` lines ~31-53 FIRST and mirror
  its exact "validate field-by-field, corrupt blob → null" pattern for
  reading the stored blob back; store via `setSetting(db, "detection_run_status", JSON.stringify(summary))`.
  This function calls `loadKnowledgeBase`+`getCatalogIndex`, runs `detect()`
  (from `@app/core/detection`) over every catalog entry, and for each
  non-resolved (`ambiguous`/`unknown`) result, upserts a row into
  `DetectionIssue` keyed by `inputFingerprint` (a deterministic hash — use
  Node's `crypto.createHash("sha256")` over the normalized input JSON,
  truncated to e.g. 16 hex chars) — on conflict, increment `occurrences` and
  bump `lastSeenAt`. If `overrideHits / totalRecords > 0.05`, call
  `logger.warn({ overrideRate, totalRecords, overrideHits }, "Detection override rate exceeded 5% of the catalog — this usually means the engine's core logic needs a fix, not another override.")`
  (import the shared pino logger per `packages/core/src/logger.ts`) AND
  upsert one additional `DetectionIssue` row with a fixed
  `inputFingerprint` sentinel (e.g. `"__override_rate_exceeded__"`) so it
  surfaces in the review queue too.

- `detectionIssues.ts`:
  ```ts
  export async function listDetectionIssues(db: Db, filter: { reviewStatus?: string }): Promise<DetectionIssueRow[]>;
  export async function resolveDetectionIssue(db: Db, id: number, adminId: number): Promise<void>;
  export async function dismissDetectionIssue(db: Db, id: number, adminId: number): Promise<void>;
  ```
  Both mutations call `logAdminAction` and validate the current
  `reviewStatus` is `"OPEN"` before transitioning (reject a transition from
  `RESOLVED`/`DISMISSED` back to itself with a clear error — no-op re-calls
  are a caller bug, surface it).

**Endpoints** (`apps/web-admin/src/routes/api/digiflazzSync.ts` — read the
existing file first for the Fastify route registration pattern used in this
file specifically, and follow `apps/web-admin` conventions per the
`web-fastify-conventions` skill if that skill is available in this session,
otherwise match sibling route files in the same directory):
- `GET /api/catalog/detection/issues` → `listDetectionIssues`
- `POST /api/catalog/detection/issues/:id/resolve` → `resolveDetectionIssue`
  using the authenticated admin's id (check how sibling routes get the
  current admin id — likely from the request's session/auth decorator)
- `GET /api/catalog/detection/metrics` → `getLatestDetectionRunStatus`

**Admin panel:** add a "Deteksi" panel to
`apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx` (read this file
first) showing the latest run's summary (resolved/ambiguous/unknown counts,
confidence distribution) and a simple list of open `DetectionIssue` rows
with a "Resolve"/"Dismiss" button each, following this codebase's existing
admin UI patterns (check what UI component library/patterns the rest of
this page already uses and match them — do not introduce a new pattern).

**Tests required:**
- `packages/db/src/crud/detectionRun.test.ts`: run summary shape and
  persistence (mirror `digiflazzSyncStatus.test.ts`'s corrupt-blob-→-null
  test if that file has one); issue upsert increments `occurrences` on a
  repeat fingerprint instead of duplicating a row; the >5% override-rate
  warning path (seed enough overrides to cross 5%, assert the sentinel issue
  row appears and `logger.warn` was called — check how other tests in this
  repo assert on the shared pino logger, e.g. spy/mock pattern, and match
  it).
- `packages/db/src/crud/detectionIssues.test.ts`: list/resolve/dismiss +
  audit log assertions + the reject-double-transition case.
- `apps/web-admin/test/detection-issues-api.test.ts` (or colocated per this
  app's existing test-file convention — check `apps/web-admin/test/`) for
  the 3 new routes.

**Done when:** typecheck green;
`npx vitest run packages/db/src/crud/detectionRun.test.ts packages/db/src/crud/detectionIssues.test.ts apps/web-admin/test/detection-issues-api.test.ts`
green. Do not attempt to visually verify the admin panel in a browser for
this task (no dev server requirement here) — a code-level render/interaction
test for the new panel component is sufficient if this app's test
conventions include component tests; check and follow whatever the sibling
components in this page already do.

---

## Task 10: Shadow-wiring into existing Digiflazz sync path

**Depends on:** Task 9. This task edits production-adjacent code —
correctness here matters more than speed; use a standard model.

**Critical constraint, repeat from Global Constraints:** `brand`, `region`,
and `existingProductId` in `groupDigiflazzPriceListByBrand`'s output MUST be
byte-identical to their current values before and after your change. The
price/isActive/circuit-breaker logic in `resyncDigiflazzCatalog` MUST be
byte-identical in behavior. You are ONLY adding new fields/side-effects,
never changing existing ones. `packages/core/src/suppliers/digiflazz.test.ts`
and `packages/db/src/crud/digiflazz.test.ts` must pass UNCHANGED — if either
requires ANY edit to pass, stop and report `BLOCKED` with the specific
failing assertion; do not "fix" the test.

**Edits to `packages/db/src/crud/digiflazz.ts`:**

1. `DigiflazzBrandGroup` interface (~line 688-707 as of the audit, verify
   current line with `Read`/`Grep` first): add
   `detection?: DetectionResult;` as an optional field, with a one-line
   doc comment: `/** Shadow-mode detection result for this group's items[0], informational only until the Task 12 cutover gate. */`.

2. `groupDigiflazzPriceListByBrand` (~line 728-757): after building each
   group, call `detect()` (via `@app/core/detection`) on the group's
   representative item (e.g. `items[0].productName`, `externalId:
   items[0].buyerSkuCode`, `supplier: "digiflazz"`) using a `CatalogIndex`
   built from `getCatalogIndex(db)` (Task 8) and `loadKnowledgeBase(db)`
   (Task 8), and attach the result to `group.detection`. **Do not use this
   result to change `brand`/`region`/`existingProductId` computation** — it
   is purely additive output.

3. `importDigiflazzBrand` (~line 857-919): inside the existing
   `$transaction`, after computing `product`/creating denominations, call
   `detect()` again (or reuse the group's precomputed result if threaded
   through — implementer's choice, whichever is cleaner) and write
   `detectionProductKey`/`detectionBaseProductKey`/`detectionStatus`/
   `detectionConfidence`/`detectionStamp` onto the `Product` row (via
   `tx.product.update`) and `detectionSkuKey`/`detectionStamp` onto each
   `Denomination` row created/updated in the loop. After the transaction
   commits, call `bumpCatalogRevision(db)` (Task 8).

4. `resyncDigiflazzCatalog` (~line 948+): after the existing price/status
   sync loop completes (do not touch the loop body), add ONE additional
   read-only pass: call `runDetectionForCatalog(db)` (Task 9) and let it
   persist its own summary/issues. This must not affect the function's
   existing return value shape or its price-write behavior — check the
   current return type/call sites before adding anything to make sure you
   are not breaking a caller (`apps/order-bot/src/jobs/index.ts:1466` per
   the audit — verify current line).

5. Any Product/Denomination-mutating function in `packages/db/src/crud/catalog.ts`
   that creates/updates a Product or Denomination should also call
   `bumpCatalogRevision(db)` after its write — read that file, find
   `createCatalogProduct`/`updateCatalogProduct`/`createDenomination`/
   `updateDenomination` (or whatever they're actually named — verify), and
   add the call at the end of each, inside the existing transaction if one
   exists.

**Tests required:**
- Existing `packages/core/src/suppliers/digiflazz.test.ts` and
  `packages/db/src/crud/digiflazz.test.ts`: run unmodified, must stay green
  — this IS the primary regression check for this task.
- New assertions (add to `packages/db/src/crud/digiflazz.test.ts` as NEW
  test cases appended at the end of existing `describe` blocks — additive
  only, never edit an existing `it(...)`): `groupDigiflazzPriceListByBrand`'s
  result includes a `detection` field per group;
  `importDigiflazzBrand`'s created Product/Denomination rows have non-null
  `detectionProductKey`/`detectionSkuKey`/`detectionStamp` after the call;
  `resyncDigiflazzCatalog` still returns/behaves exactly as before (copy an
  existing assertion on its return shape verbatim as a sentinel, don't
  invent a new expectation).

**Done when:** `npx vitest run packages/core/src/suppliers/digiflazz.test.ts packages/db/src/crud/digiflazz.test.ts`
is green with ZERO diff inside those two test files other than pure
additions at the end, plus typecheck green.

---

## Task 11: Export real-catalog fixture + collision/keyStability tests + diff script

**Depends on:** Task 10 (needs `detectionProductKey` persisted to read back
from a real/seeded DB).

**File to create:** `scripts/export-detection-fixture.ts` — connects to
whatever DB this worktree's `.env` points at (dev DB, NOT necessarily
production — this task builds the tooling; actually running it against
production is Task 12/the human gate, not this task), reads every `Product`
with a non-null `digiflazzBrand` joined to its `Denomination`s, and writes
ONLY `{ productName, brand, category, type, buyerSkuCode }` per row (no
price, no customer data, no credentials — enforce this by construction: the
Prisma `select` clause must not include any other field) to
`packages/core/src/detection/__fixtures__/catalogSnapshot.json`. Read-only,
never in `pretest`. Add a `"export-detection-fixture": "tsx scripts/export-detection-fixture.ts"`
entry to root `package.json` `scripts`. Since this worktree's dev DB likely
has only sample/seed data (not a real production catalog), running this
script now will produce a small/empty snapshot — that's expected and fine
for this task; note it in your report. Commit whatever `catalogSnapshot.json`
this produces (even if small) as a placeholder — Task 12 (the human gate)
will note whether a fresher export against real data is needed before
cutover.

**File to create:** `packages/core/src/detection/collision.test.ts` (AC-18):
reads `catalogSnapshot.json` via `readFileSync`+`JSON.parse` (this is
harness I/O, not engine I/O — allowed per INV-5's actual scope, and this
repo's own `tests/helpers/testdb.ts` already does synchronous I/O in test
harnesses), runs `detect()` (or just `buildCatalogIndex` +
`productKey`-collision detection directly) over every row, and FAILS if two
rows with different `buyerSkuCode` produce the same `productKey` UNLESS an
explicit code comment/allowlist entry in the test documents why (there
should be none in this small fixture — if there are, that's real signal to
report, not to silence).

**File to create:** `packages/core/src/detection/keyStability.test.ts`
(AC-15) + `packages/core/src/detection/__fixtures__/goldenKeys.json`: for
every row in `catalogSnapshot.json`, compute `productKey`/`skuKey` with the
current engine+knowledge and compare against the checked-in
`goldenKeys.json` (an array of `{ buyerSkuCode, productKey, skuKey,
detectorStamp }`). First run: generate `goldenKeys.json` from the current
engine output (this establishes the golden file) and commit it alongside
the test. The test fails if a future engine/knowledge change silently
produces a different key for the same `buyerSkuCode` without the golden
file being deliberately regenerated in the same commit — this is the
mechanism, document it with a comment explaining the intended workflow
("if this test fails, either your change unintentionally altered key
computation — fix it — or you intended to and must regenerate
goldenKeys.json via `scripts/recompute-detection-keys.ts` and review the
diff before committing").

**File to create:** `scripts/recompute-detection-keys.ts` — dry-run by
default (prints the diff between current `goldenKeys.json` and freshly
computed keys, matching the style of `scripts/split-digiflazz-regions.ts`
per the audit — read that file first for the dry-run-by-default CLI
convention used in this repo), writes only with an explicit `--apply` flag.

**File to create:** `scripts/detection-key-diff.ts` — the script Task 12
(the human gate) will run against a real production-scale catalog. Connects
to the DB, for every existing `Product` with non-null `digiflazzBrand`:
recompute what `digiflazzGroupKey(brand, productName)` (the CURRENT/legacy
function, still untouched at this point — import it from
`@app/core/suppliers/digiflazz`) would produce vs. what the new engine's
`detect()` produces for the same row, and print a table of any row where the
two disagree on grouping (i.e., where the legacy `displayName` and the
engine's `productKey`-implied grouping would put a row in a different
bucket). Exit code 0 if zero disagreements, 1 otherwise, with the
disagreement table printed either way. Standalone script, never in
`pretest`, never auto-run.

**Done when:**
`npx vitest run packages/core/src/detection/collision.test.ts packages/core/src/detection/keyStability.test.ts`
green, and `scripts/detection-key-diff.ts` runs successfully (exit 0 or 1,
either is fine for THIS task — the content of its output is Task 12's
concern) against whatever DB this worktree's `.env` points at, with its
output pasted into your report.

---

## Task 13: Cutover — digiflazzGroupKey/parseProductRegion become engine wrappers

**⚠️ DO NOT START THIS TASK until the controller explicitly confirms the
Task 12 human gate (production key-diff review) has been approved by the
user.** If dispatched without that confirmation in the prompt, respond
`NEEDS_CONTEXT` and stop.

**Depends on:** Task 11 + explicit human approval of the Task 12 diff.

**Edits to `packages/core/src/suppliers/digiflazz.ts`:**

`parseProductRegion`, `stripRegionSuffix`, `digiflazzGroupKey` (lines
170-244 as of the audit — verify current lines first) become thin wrappers
delegating to the detection engine's `extractFeatures`/`keys` primitives,
preserving their EXACT existing external signatures and return types (no
caller outside this file should need to change). The denylist currently
inline in `parseProductRegion` (`INSTANT`, `PROSES CEPAT`, the duration-range
regex) moves to become `noise`-category `DetectionToken` rows (already
present in `DEFAULT_KNOWLEDGE_BASE` from Task 1 — confirm they're there,
add if the Task 1 implementer missed any) — after this task, extending that
denylist means adding a DB row, not editing this file.

**Edit to `packages/db/src/crud/digiflazz.ts`:** `detectMixedDigiflazzProducts`
(~line 1204-1297) switches its region-membership check from re-parsing
`denomination.name` via the old `parseProductRegion` to reading the
persisted `detectionProductKey`/attributes computed in Task 10's shadow
wiring.

**The critical proof for this task:** `packages/core/src/suppliers/digiflazz.test.ts`
and `packages/db/src/crud/digiflazz.test.ts` — run them BEFORE touching
anything (record pass/fail as your before-state), make the wrapper changes,
run them again. **Every single existing test case must still pass with
IDENTICAL assertions** (you may ADD new test cases at the end of existing
`describe` blocks documenting that the engine now backs these functions, but
you may not modify or delete a single existing `it(...)` block). If any
existing test fails after your change, that is a real regression — fix the
wrapper, do not touch the test. Report this before/after comparison
explicitly, pasting both test run outputs.

**Done when:**
`npx vitest run packages/core/src/suppliers/digiflazz.test.ts packages/db/src/crud/digiflazz.test.ts packages/core/src/detection`
is green, with a diff showing zero test-file lines removed/altered inside
the two `digiflazz.test.ts` files (only additions), plus full
`pnpm -r typecheck && npx tsc -p tsconfig.test.json` green.
