# Detection Engine

> Written in English, unlike the rest of `docs/` (which is Indonesian),
> because every identifier, comment and invariant name inside
> `packages/core/src/detection/**` is English and this document is mostly a
> map of those names. Prose elsewhere in `docs/` stays Indonesian.

The Detection Engine turns a free-form supplier product name (plus whatever
loose metadata came with it) into a stable, versioned identity: a
`baseProductKey`, a `productKey`, and a `skuKey`. It exists so that "which
product is this row?" is answered by **one pure, testable function driven by
editable data**, instead of by per-product `if` branches scattered across
supplier adapters. Today it is load-bearing for exactly one thing — the
Digiflazz region/grouping logic (`parseProductRegion` and friends) — and
observational everywhere else; see [§8 Shadow mode vs. cutover
status](#8-shadow-mode-vs-cutover-status).

---

## 1. Overview

- **Input:** a loose, untrusted object (`DetectionInput` — every field
  optional, `detect()` accepts `unknown`).
- **Output:** a `DetectionResult` discriminated union —
  `resolved` / `ambiguous` / `unknown`, always carrying `evidence[]` and a
  `detectorVersion` stamp.
- **Never throws.** For any input at all — `null`, `42`, an emoji, a
  10,000-character string — it returns a typed result (INV-3).
- **Deterministic.** Same input + same `deps` ⇒ byte-identical
  `JSON.stringify` output, every time (INV-1).
- **Pure.** `packages/core/src/detection/**` performs no I/O, imports
  neither `@prisma/client` nor `@app/db`, and calls no clock/RNG (INV-5).
  This is enforced mechanically — see [§10](#10-observability-and-enforcement).

---

## 2. Architecture: Engine vs. Knowledge

Two layers, deliberately separated so that "we misclassified a product name"
is normally a **data** fix, not a code change.

| | Engine (code) | Knowledge (data) |
|---|---|---|
| Where | `packages/core/src/detection/*.ts` | Postgres tables `detection_tokens` / `detection_aliases` / `detection_overrides`, seeded from `detection/knowledge/defaultVocabulary.ts` |
| Contains | normalization, tokenization, classification, key serialization, scoring, index lookup, the decision rule | which words are platform/edition/region/distribution/noise, which are product-defining, aliases, per-name overrides |
| May contain literal product names | **No** (AC-01) | Yes — this and `detection/__fixtures__/**` are the only places |
| Changing it means | a deploy + a `DETECTOR_VERSION` bump if keys can move | a DB row (crud helper call / seed script — no admin-panel UI yet, see [§7](#7-adding-a-new-product-in-5-steps)) |
| Loaded by | direct import | `loadKnowledgeBase(db)` — `packages/db/src/crud/detectionKnowledge.ts:66` |

The dependency direction of the monorepo enforces purity: `@app/core` has no
dependency on `@app/db` or `@prisma/client` at all, so the engine
*structurally cannot* reach a database. All data arrives as function
parameters (`deps: { knowledge, index }`), injected by the caller.

Files:

```
packages/core/src/detection/
  types.ts            all shared types (DetectionInput/Result, KnowledgeBase, CatalogEntry)
  version.ts          DETECTOR_VERSION + buildDetectorStamp()
  normalize.ts        unknown -> normalized string
  tokenize.ts         tokenize() / despace()
  features.ts         extractFeatures() + extractTrailingParenthetical()
  keys.ts             buildBaseProductKey / buildProductKey / buildSkuKey
  scoring.ts          weight constants + computeConfidence()
  indexBuild.ts       buildCatalogIndex() -> CatalogIndex (5 Maps)
  engine.ts           detect()
  index.ts            barrel ("@app/core/detection")
  knowledge/schema.ts             zod validator for KnowledgeBase
  knowledge/defaultVocabulary.ts  DEFAULT_KNOWLEDGE_BASE (seed/fallback)
  __fixtures__/                   synthetic + real-catalog fixtures, golden keys
```

DB-side helpers live in `packages/db/src/crud/`: `detectionKnowledge.ts`,
`detectionIndex.ts`, `detectionRun.ts`, `detectionIssues.ts`.

---

## 3. Identity model

Three layers, each strictly a refinement of the one above.

### `baseProductKey`

`coreTokens.join(" ")` — `keys.ts:46`. Core tokens are the name's tokens
*after* every knowledge-classified token has been removed. **Not sorted**:
word order is meaningful in a product name.

### `productKey`

`keys.ts:56`:

```
productKey = baseProductKey                                   (no defining tokens)
productKey = `${baseProductKey}::${sortedDefiningPairs}`      (otherwise)
```

`sortedDefiningPairs` = `definingTokens` deduplicated by
`[category, canonical]`, rendered as `category=canonical`, sorted with a
plain `<`/`>` comparator (never `localeCompare`), joined with `,`.

Only tokens with `isProductDefining: true` land here. That is what makes
"same product, different region" collapse onto one `productKey` **by
design** (AC-04) — region tokens are `isProductDefining: false`.

### `skuKey`

`keys.ts:73`:

```
skuKey = `${productKey}::denom=${denomination ?? "none"}${distributionSuffix}`
```

where `distributionSuffix` is `""` when there are no distribution tokens,
otherwise `,` followed by the same sorted `category=canonical` rendering of
`distributionTokens`. This is the layer where region variants are separated
again.

**Worked example** (real fixture row, `__fixtures__/goldenKeys.json`):

```
productName  "MOBILE LEGENDS (Indonesia)"
denomination "Mobile Legends Weekly Diamond Pass"  (production passes the display name)

normalize    "mobile legends (indonesia)"
paren        "indonesia"  -> region token, isProductDefining:false -> distributionTokens
tokens       ["mobile","legends"] -> "mobile" is a platform token (defining), "legends" is core

baseProductKey  "legends"
productKey      "legends::platform=mobile"
skuKey          "legends::platform=mobile::denom=<normalized denom>,region=indonesia"
```

Note the artifact: because `mobile` is a `platform` token in the default
vocabulary, `baseProductKey` for "MOBILE LEGENDS" is `"legends"`. The keys
are opaque identifiers, not display names — this is correct but surprising
the first time you read one. See [§9](#9-known-limitations).

### Versioning

`buildDetectorStamp(knowledgeRevision)` (`version.ts:15`) produces
`"${DETECTOR_VERSION}+k${knowledgeRevision}"`, e.g. `"1.0.0+kdefault"`. It is
persisted on every row the engine touches (`Product.detectionStamp`,
`Denomination.detectionStamp`) so a stale row is identifiable without
recomputation. **Bump `DETECTOR_VERSION` (`version.ts:8`) whenever engine
logic changes in a way that could move an existing key.**

Key drift is caught by `keyStability.test.ts` against the checked-in
`__fixtures__/goldenKeys.json` (232 real catalog rows). If that test fails
you either introduced an unintended regression, or you meant to change keys
and must regenerate the golden file:

```
npx tsx scripts/recompute-detection-keys.ts          # dry-run diff (default)
npx tsx scripts/recompute-detection-keys.ts --apply  # rewrite goldenKeys.json
```

Review the printed diff and commit the regenerated file in the same commit
as the change that caused it.

---

## 4. Pipeline walkthrough

`detect(input, deps)` — `engine.ts:466`.

1. **Coerce** (`coerceInput`, `engine.ts:118`). Every field access goes
   through `safeStringField` (`engine.ts:113`), which returns `null` for
   anything that is not a non-empty string. Non-object input yields an
   all-null record. Nothing is destructured unguarded.
2. **Normalize** (`normalize.ts:38`). NFKC (full-width folding) → NFKD +
   strip `\p{Mn}` (diacritics) → lowercase → map `-` `_` `.` `:` to spaces →
   collapse whitespace runs → trim. Non-destructive (INV-2): it never drops a
   digit, stems, or truncates. An empty result short-circuits to
   `unknown / "no usable product name"` (`engine.ts:471`).
3. **Override check** (`findOverride`, `engine.ts:144`). Exact match of the
   normalized name or the external id against `knowledge.overrides`.
   A hit short-circuits the whole pipeline: `resolved`, `confidence: 1`,
   `score: W_OVERRIDE`, one evidence entry (`engine.ts:483`).
4. **Extract features** (`extractFeatures`, `features.ts:145`):
   - locate and slice off a trailing `(...)` group
     (`extractTrailingParenthetical`, `features.ts:48`);
   - drop it entirely if its text matches a `noise`-category knowledge token
     or the structural duration-range pattern (`features.ts:71`) — otherwise
     keep it as `parentheticalSuffix` and classify its own words;
   - alias-expand the paren-stripped name (`expandAlias`, `features.ts:135`);
   - tokenize (`tokenize.ts:14`) and route each token into `coreTokens`,
     `definingTokens`, or `distributionTokens` (`classifyToken`,
     `features.ts:95`). `noise` tokens are dropped.
5. **Build the input's own keys** (`engine.ts:499-501`) and **look up
   candidates** (`lookupCandidates`, `engine.ts:183`): at most **five**
   `Map.get` calls — `byExternalId`, `byProductKey`, `byBaseKey`,
   `byNormalizedName`, `byDespacedName` — unioned, deduplicated by `refId`,
   then re-sorted by `refId` so Map iteration order never leaks into output.
   No candidate ⇒ `unknown` (`engine.ts:511`).
6. **Score** every candidate (`scoreCandidate`, `engine.ts:273`) against the
   ladder in [§5](#5-scoring), then dedupe by `productKey` keeping the
   higher-scoring representative, ties broken by `refId`
   (`dedupeByProductKey`, `engine.ts:369`).
7. **Decide** (`engine.ts:561-592`):
   - `winner.score < ACCEPT_THRESHOLD` ⇒ `unknown`, with the score in the
     reason string;
   - no runner-up, or `winner.score - runnerUp.score > MARGIN` ⇒ `resolved`,
     with `attributes`, `confidence`, `evidence[]` and `conflicts[]`;
   - otherwise ⇒ `ambiguous`, listing up to 10 candidates.

`conflicts[]` (`buildConflicts`, `engine.ts:429`) records every level-4/5
signal a *losing* candidate held that the winner did not hold at equal or
greater weight — i.e. only genuinely discriminating signals, not shared ones.

### The index

`buildCatalogIndex(entries, knowledge, stamp)` — `indexBuild.ts:67` — builds
five real `Map`s (`indexBuild.ts:29`) and sorts every bucket
lexicographically by `productKey` before freezing (INV-1). `detect()` never
scans `entries`. Measured: **1,000 `detect()` calls against a 10,000-entry
index run in ~87 ms** (budget 2,000 ms), `benchmark.test.ts`.

---

## 5. Scoring

Five priority bands ("the ladder"), strongest first. Constants live in
`scoring.ts:10-20` and are asserted directly by `scoring.test.ts` — changing
one of them breaks a test rather than silently changing behavior.

| Level | Signal | Constant | Value |
|---|---|---|---|
| 1 | explicit override (short-circuit) | `W_OVERRIDE` | 100 |
| 2 | stable external id (`buyerSkuCode`) | `W_EXTERNAL_ID` | 60 |
| 3 | normalized core-name match | `W_NAME_CORE` | 40 |
| 3 (weak) | despaced-name match | `W_NAME_CORE_DESPACED` | 25 |
| 3 | per matched product-defining token | `W_DEFINING_TOKEN` / `DEFINING_TOKEN_CAP` | 10 / 30 |
| 4 | structured metadata (`category`/`type`) | `W_STRUCTURED_META` | 15 |
| 5 | distribution (`country`/`variant`/`publisher`, distribution tokens) | `W_DISTRIBUTION` / `DISTRIBUTION_CAP` | 5 / 10 |
| — | accept threshold | `ACCEPT_THRESHOLD` | 40 |
| — | winner/runner-up separation | `MARGIN` | 15 |

Why these numbers:

- **`ACCEPT_THRESHOLD == W_NAME_CORE == 40`.** A full core-name match must be
  sufficient on its own; nothing weaker may be.
- **`W_STRUCTURED_META + DISTRIBUTION_CAP = 25 < 40`.** This is AC-02
  enforced *arithmetically*: country + variant + publisher + category/type,
  all of them together, can never reach the accept threshold. Lowering
  `ACCEPT_THRESHOLD` in the future breaks `scoring.test.ts` rather than
  quietly permitting a false resolve.
- **`W_NAME_CORE_DESPACED = 25 < 40`.** `"PUBGMobile"` (no separator)
  deliberately lands `ambiguous`, not `resolved`. It is fixed by adding a
  `DetectionAlias` row — data, not code.
- **`MARGIN = 15 > DISTRIBUTION_CAP = 10`.** Two candidates can never be
  split into a confident `resolved` by distribution evidence alone.
  Consequence (accepted): a strong level-3 winner *can* be demoted to
  `ambiguous` by a level-4/5-only decoy. That is a safe failure mode — it
  routes to the review queue instead of resolving wrongly.
- **`DEFINING_TOKEN_CAP = 30`.** At most three defining tokens count, so a
  long name cannot win on length alone.
- **`W_EXTERNAL_ID = 60`** only applies when
  `knowledge.externalIdStableBySupplier[supplier] === true`. Unlike tokens,
  aliases and overrides, **`externalIdStableBySupplier` is not admin-editable
  data** — `loadKnowledgeBase` (`packages/db/src/crud/detectionKnowledge.ts:122`)
  always reads this field straight off the static `DEFAULT_KNOWLEDGE_BASE`,
  regardless of what the DB tables contain. There is no `DetectionToken`-style
  table, column, or admin upsert helper for it. If a supplier's ids turn out
  not to be stable, turning the signal off means editing
  `defaultVocabulary.ts` and deploying — a known asymmetry in the knowledge
  layer, see [§9](#9-known-limitations).

`computeConfidence(score, maxAttainable)` (`scoring.ts:39`) =
`Math.round((score / max) * 100) / 100`, returning `0` (never `NaN`) when
`max === 0`. `maxAttainableScore` is computed per call at `engine.ts:525`
and depends on whether the level-2 signal is active.

---

## 6. Knowledge layer

### Shape

```ts
KnowledgeBase = {
  tokens:   { category, token, canonical, isProductDefining, enabled }[]
  aliases:  { alias, expandsTo, reason }[]
  overrides:{ matchKind: "normalized_name" | "external_id", matchValue,
              baseProductKey, productKey, reason }[]
  externalIdStableBySupplier: Record<string, boolean>
  revision: string
}
```

Categories: `platform`, `distribution`, `region`, `edition`, `denomination`,
`noise`.

- `platform` / `edition` / `distribution` — `isProductDefining: true`
  (they change the actual product/account/client).
- `region` — `isProductDefining: false` (distribution-only; separates
  `skuKey`, never `productKey`).
- `noise` — dropped entirely; this is where the old Digiflazz denylist
  (`instant`, `proses cepat`) now lives.

**"Global" is not a region, and this is an easy trap to fall into.** Every
region suffix (`indonesia`, `malaysia`, `brazil`, `russia`, `filipina`,
`singapore`, plus the 2-letter codes) is category `region` /
`isProductDefining: false`, so they all collapse onto one `productKey`
(AC-04). `"global"`, by contrast, is classified `category: "distribution"`,
`isProductDefining: true` (`defaultVocabulary.ts:74-79`) — it is *not* in the
region list at all. This is intentional: "Global" describes a distribution
channel, not a geography, so `"MOBILE LEGENDS (Global)"` gets its own
distinct `productKey` (`legends::distribution=global,platform=mobile`)
instead of collapsing with `"MOBILE LEGENDS (Indonesia)"` and its regional
siblings (`legends::platform=mobile`) — confirmed correct in
`defaultVocabulary.ts`'s own comment and exercised by
`collision.test.ts`'s `ALLOWLISTED_COLLISIONS` (it explicitly notes "Global"
is NOT in the Mobile Legends collision bucket). The practical consequence:
when adding a new token, pick the category that is *semantically* correct —
"is this word a geography that should collapse with other regions?" vs. "is
this word a distribution channel/client that changes the product?" — don't
default to `region` just because the word visually looks like the other
parenthetical suffixes you've seen.

Validation is a zod schema (`knowledge/schema.ts`), which also rejects
duplicate `[category, token]` pairs. The loader throws on invalid data rather
than silently degrading.

### Where the data actually comes from

`loadKnowledgeBase(db)` (`packages/db/src/crud/detectionKnowledge.ts:66`)
reads all three tables (WeakMap + 30s TTL + revision-counter cache, same
pattern as `crud/settings.ts`) and:

- falls back to `DEFAULT_KNOWLEDGE_BASE` **only when all three tables are
  completely empty**;
- otherwise DB rows are the full picture, unioned with the default
  `noise` entries.

> **This is the trap.** Once *any* environment has a single detection row,
> editing `defaultVocabulary.ts` changes nothing there. You must re-run
> `pnpm seed-detection-knowledge` in that environment (idempotent, upserts on
> `[category, token]`, writes one audit row and bumps the revision once).

### Editing it

Programmatic path — call these directly (there is no admin-panel UI for
tokens/aliases/overrides yet, see [§7](#7-adding-a-new-product-in-5-steps));
each audits via `logAdminAction` and bumps `detection_knowledge_revision`,
which invalidates both caches:

- `upsertDetectionToken(db, args, adminId)` — `detectionKnowledge.ts:140`
- `upsertDetectionAlias(db, args, adminId)` — `detectionKnowledge.ts:179`
- `upsertDetectionOverride(db, args, adminId)` — `detectionKnowledge.ts:202`
  (`reason` is `NOT NULL` in the schema: an override without a written
  reason is not representable)

Raw tables, if you must: `detection_tokens`, `detection_aliases`,
`detection_overrides` (`prisma/schema.prisma:1778+`). Bump
`Settings["detection_knowledge_revision"]` by hand afterwards, or the caches
will serve stale data for up to 30 seconds and the index will not rebuild.

---

## 7. Adding a new product in ≤5 steps

You almost never touch engine code. In order of preference. **Read this whole
section before running any verification command** — steps 2-4 (the DB-row
path) and step 5's scripts (the static-vocabulary path) verify two genuinely
different things, and using the wrong one for what you changed will make you
wrongly conclude your edit had no effect.

**Step 1 — Do nothing and check.** Most names already work. Read the review
queue in the admin panel (Digiflazz Sync → "Deteksi"), or run the
whole-catalog comparison:

```
npx tsx scripts/detection-key-diff.ts     # whole-catalog batch comparison: engine productKey grouping vs.
                                           # legacy digiflazzGroupKey grouping. NOT a single-row/single-name
                                           # checker — there is no "run just this row through the engine" mode.
```

If the name already resolves to the right `productKey`, you are done.

**Step 2 — Is a word being classified wrongly (or not at all)?** Add or edit
a `DetectionToken` row. Pick the category (`platform`/`edition`/
`distribution`/`region`/`noise`) and, critically, `isProductDefining`:
`true` means the word creates a *different product*, `false` means it only
distinguishes a SKU/region of the same product. Region words are `false`,
and see [§6](#6-knowledge-layer)'s "Global is not a region" note before
copying the region pattern for a new distribution-channel-like word. This
changes both grouping and keys for every row containing that word.

**Step 3 — Is it a spelling/shorthand problem?** Add a `DetectionAlias`
(`alias` → `expandsTo`, both normalized). This is the fix for
`"PUBGMobile"`-shaped names, glued brand names, and supplier shorthand. It is
matched against the full paren-stripped normalized name (or its despaced
form), not per-word.

**Step 4 — Is it genuinely one irregular row?** Add a `DetectionOverride`
(`matchKind: "normalized_name" | "external_id"`, `matchValue`, the exact
`baseProductKey`/`productKey` you want, and a mandatory `reason`). It
short-circuits everything. Use this last — if overrides exceed 5% of the
catalog, a run logs a warning and raises a review-queue issue, because that
means the engine's logic needs fixing rather than more overrides.

Steps 2-4 are all **data**, written through
`upsertDetectionToken`/`upsertDetectionAlias`/`upsertDetectionOverride`
(`packages/db/src/crud/detectionKnowledge.ts:140,179,202`). **There is
currently no admin-panel UI for these three tables** — call the helper
directly from a one-off script/REPL with a `Db` handle and an `adminId`
(each call audits via `logAdminAction` and bumps
`detection_knowledge_revision` itself, invalidating the knowledge/index
caches immediately, no 30s wait needed).

**Step 5 — Make the change take effect, and prove it.** This step forks
depending on *where* you made the change:

**(A) You edited `defaultVocabulary.ts` (code — needs a deploy):**

```
pnpm seed-detection-knowledge                 # REQUIRED — upserts the new/changed rows into the DB tables
npx vitest run packages/core/src/detection    # keyStability.test.ts flags any key drift
npx tsx scripts/recompute-detection-keys.ts   # dry-run: shows exactly which keys moved
```

`detection-key-diff.ts` and `recompute-detection-keys.ts` both import
`DEFAULT_KNOWLEDGE_BASE` directly and compute keys from it — **neither ever
calls `loadKnowledgeBase(db)`**. That is exactly right for verifying a
`defaultVocabulary.ts` edit, because after `pnpm seed-detection-knowledge`
the DB rows are upserted to mirror the static source, so these scripts stay
a valid proxy for "did my static-vocabulary change compute the keys I
expect."

If keys moved on purpose: bump `DETECTOR_VERSION` when the cause was engine
logic, regenerate `goldenKeys.json` with `--apply`, review the diff, and
commit both together.

**(B) You added/edited a row directly via the upsert helpers in step 2-4
(data — live immediately, no deploy):**

**`detection-key-diff.ts` and `recompute-detection-keys.ts` will show ZERO
change for this edit.** They read only `DEFAULT_KNOWLEDGE_BASE`, never the
DB, so they cannot see a DB-only row no matter how correct it is — running
them here proves nothing about whether your edit took effect, and will
mislead you into thinking it didn't. To actually verify a DB-row change:

- trigger a DB-backed detection pass — either wait for the next hourly
  `runDetectionForCatalog` tick, or invoke it directly in a script — which
  *does* call `loadKnowledgeBase(db)` (`packages/db/src/crud/detectionRun.ts:180`),
  so it picks up your row immediately (the cache was already invalidated by
  the upsert call in step 2-4); then check the admin panel's Digiflazz Sync →
  "Deteksi" review queue and metrics for the affected record(s);
- or, for a quick one-off check without waiting for a run, write a small
  script that calls `loadKnowledgeBase(db)` + `getCatalogIndex(db)`
  (`packages/db/src/crud/detectionIndex.ts`) and feeds the result into
  `detect()` directly for the input you care about.

Only if none of steps 2-4 can express the fix (for example: a *multi-word*
region such as "Hong Kong", which per-word tokenization cannot classify) do
you change `features.ts` — and then you are changing the engine, which means
a `DETECTOR_VERSION` bump and a full golden-key review (path A above).

---

## 8. Shadow mode vs. cutover status

**Engine-backed and live in production paths:**

- `parseProductRegion` (`packages/core/src/suppliers/digiflazz.ts:192`),
  `stripRegionSuffix` (`:222`), `digiflazzGroupKey` (`:252`) are thin
  wrappers over `extractTrailingParenthetical` + `extractFeatures`. There is
  no region regex or denylist left in that file.
- `detectMixedDigiflazzProducts` (`packages/db/src/crud/digiflazz.ts:1351`)
  is engine-backed **transitively**, because it calls `parseProductRegion`.
  It deliberately still parses per-denomination names rather than reading the
  persisted columns — see [§9](#9-known-limitations).

**Shadow only (written, observable, but not a decision input anywhere):**

- `groupDigiflazzPriceListByBrand` attaches a `detection?: DetectionResult`
  to each group (`crud/digiflazz.ts:765-808`). `brand`, `region` and
  `existingProductId` are computed exactly as before.
- `importDigiflazzBrand` writes `Product.detection*` and
  `Denomination.detectionSkuKey`/`detectionStamp` after the transaction
  commits (`writeShadowDetectionForImport`, `crud/digiflazz.ts:915`), then
  calls `bumpCatalogRevision`.
- The hourly job runs `runDetectionForCatalog` after the Digiflazz resync.

**Nothing in the application reads `detectionProductKey` /
`detectionBaseProductKey` / `detectionSkuKey` back as an input to any
decision.** (Verified: the only occurrences outside tests are the writes
above.) Those columns exist for observability, for the review queue, and as
the migration surface for a future cutover.

---

## 9. Known limitations

1. **Region vocabulary is a closed enumeration derived from a 15-brand dev
   catalog.** The known set is
   `{indonesia, filipina, russia, brazil, malaysia, singapore, id, sg, my}`
   (`knowledge/defaultVocabulary.ts:82-159`). A production region suffix
   outside that set silently falls back to contributing nothing to
   `distributionTokens`, which re-opens the identical-`skuKey` bug Task 12b
   closed. **Before any real production cutover, re-run the distinct
   `(...)`-suffix scan against the production catalog, not the dev fixture.**
2. **Multi-word regions cannot be fixed by vocabulary alone.** Tokenization
   is per-word, so `"Hong Kong"` / `"Timur Tengah"` will never match a single
   token row. Closing that needs a `features.ts` change (phrase matching),
   not a DB row.
3. **`loadKnowledgeBase` only falls back to `DEFAULT_KNOWLEDGE_BASE` when all
   three tables are empty.** In any already-seeded environment, editing
   `defaultVocabulary.ts` has zero effect until `pnpm seed-detection-knowledge`
   is re-run there. This is a required deploy step and is easy to forget —
   everything stays green while shipping the old behavior.
4. **`parseProductRegion` / `stripRegionSuffix` / `digiflazzGroupKey` are
   permanently pinned to the static `DEFAULT_KNOWLEDGE_BASE`**, not to the
   DB-backed knowledge base. They are synchronous and pure and live in
   `@app/core`, which cannot import `@app/db`. An admin-added `noise` token
   therefore takes effect in detection runs and index builds but **not** in
   these three functions. Extending their denylist means editing
   `defaultVocabulary.ts` and deploying. This split-brain is by design, but
   it is real.
5. **`detectMixedDigiflazzProducts` cannot use the persisted columns.**
   `Product.detectionProductKey` is Product-level and uniform across all of a
   product's denominations, while that function's entire purpose is detecting
   region *mixing between denominations inside one product*. Using the
   persisted key would collapse every mixed product into one bucket. A real
   fix needs per-denomination detection storage — a schema redesign, out of
   scope here.
6. **Shadow denomination writes are N+1 separate auto-committed statements**
   (`crud/digiflazz.ts:942-950`), deliberately outside the import
   transaction. A crash mid-loop leaves some denominations of that one
   import batch stamped and others not. **There is no automatic healing for
   this partial-stamp case.** `runDetectionForCatalog` (the hourly job) does
   *not* write `Product.detection*`/`Denomination.detectionSkuKey`/
   `detectionStamp` at all — it only counts, upserts `DetectionIssue` rows,
   bumps override `hitCount`, and stores the run-summary blob. Only
   `writeShadowDetectionForImport` writes those columns, and only at import
   time. The only way to retry a partially-stamped batch today is to re-run
   the same import (`importDigiflazzBrand` for that brand).
   `bumpCatalogRevision` at `crud/digiflazz.ts:1046` is likewise unguarded —
   a failure there just means the index waits out its 30s TTL.
7. ~~`DetectionOverride.hitCount` is declared but never incremented.~~
   **Fixed in commit `c77827ef`.** `incrementOverrideHitCount`
   (`packages/db/src/crud/detectionRun.ts`) now bumps the matched override
   row's `hitCount` on every real override hit inside `runDetectionForCatalog`,
   verified by a test asserting a running 0→1→2 counter. The run-level
   `overrideHits` count in the metrics blob was always real and remains so.
8. **Coverage is *configured* at a 90% threshold for
   `packages/core/src/detection/**` only** (`vitest.config.ts`
   `coverage.thresholds`), not repo-wide — but that threshold is **not wired
   into any automated gate**. `package.json`'s `test` script is plain
   `vitest run` (no `--coverage`), and `pretest` never invokes coverage
   either, so the threshold only actually fires when a human manually runs
   `npx vitest run --coverage`. No coverage tooling existed in this repo
   before this work; retrofitting a global threshold, and wiring this one
   into CI, are both separate, explicitly-approved-as-deferred projects.
9. **Keys are opaque.** `baseProductKey` for "MOBILE LEGENDS" is `"legends"`,
   because `mobile` is a platform token. Never render a detection key to a
   buyer or an admin as a product name.
10. **`externalIdStableBySupplier` is code-level configuration, not
    admin-editable data**, unlike tokens/aliases/overrides. See
    [§5](#5-scoring)'s note on `W_EXTERNAL_ID` for the mechanism — this is a
    known asymmetry in the knowledge layer, not something this pass fixes.
11. **Confidence is computed on two different scales depending on the call
    site, and the admin panel's number is systematically deflated.**
    `engine.ts`'s `maxAttainableScore` budgets `W_EXTERNAL_ID = 60` whenever
    `isExternalIdActive` is true (caller passed a `supplier` +
    non-null `externalId`, and that supplier is flagged stable) — but
    `crud/detectionIndex.ts`'s `CatalogEntry` mapping always sets
    `externalId: null` in production (a known, separately-documented
    limitation — "not exhaustive by design"), so `index.byExternalId` is
    always empty and that 60-point budget line is **structurally
    unreachable** in production even when it's counted in the denominator.
    Three call sites pass different `externalId`/`supplier` combinations to
    `detect()` for the conceptually same product —
    `groupDigiflazzPriceListByBrand` passes both, `writeShadowDetectionForImport`
    passes neither, `runDetectionForCatalog` passes neither — so the *same*
    product can report a different confidence in different code paths for
    an identical, perfectly-matched resolution. **The "Distribusi keyakinan"
    confidence distribution in the admin Deteksi panel is not currently a
    reliable signal for judging detection health before a production
    cutover.** Candidate fixes (neither implemented — needs a follow-up
    task): (i) exclude `W_EXTERNAL_ID` from `maxAttainableScore` when
    `index.byExternalId.size === 0`, or (ii) actually populate
    `externalId`/`category`/`type` in `detectionIndex.ts`'s `CatalogEntry`
    mapping (which would also make scoring levels 2 and 4 functional in
    production — currently structurally dead there too).
12. **A resolved/dismissed review-queue issue can never automatically
    re-open.** `detectionRun.ts`'s `upsertDetectionIssue` `update` branch
    refreshes `status`/`reason`/`candidates`/`detectorStamp` and increments
    `occurrences` on a repeat fingerprint, but never resets `reviewStatus`
    back to `"OPEN"` — and the admin panel only queries `reviewStatus=OPEN`
    issues. So if an admin resolves/dismisses an issue believing a knowledge
    edit fixed it, but the edit didn't actually work, every later detection
    run keeps silently re-upserting the same fingerprint with a climbing
    `occurrences` count, permanently invisible to the review queue. Needs a
    follow-up task deciding the right re-open policy (e.g. always reset to
    `OPEN` on any re-occurrence after resolution, or only reset if
    `detectorStamp` changed, or add a distinct "recurred after resolution"
    signal) — not implemented here.

---

## 10. Observability and enforcement

**Health, at a glance:** admin panel → Digiflazz Sync page → **"Deteksi"**
(`apps/web-admin/client/src/pages/DigiflazzSyncPage.tsx:107`). It shows the
last run's resolved/ambiguous/unknown counts and confidence distribution,
plus the open review queue with Resolve/Dismiss buttons.

**Endpoints** (`apps/web-admin/src/routes/api/digiflazzSync.ts`):

| Route | Handler |
|---|---|
| `GET /api/catalog/detection/metrics` | `getLatestDetectionRunStatus` (`:179`) |
| `GET /api/catalog/detection/issues` | `listDetectionIssues` (`:185`) |
| `POST /api/catalog/detection/issues/:id/resolve` | `resolveDetectionIssue` (`:195`) |
| `POST /api/catalog/detection/issues/:id/dismiss` | `dismissDetectionIssue` (`:213`) |

**Metrics blob.** `runDetectionForCatalog` (`crud/detectionRun.ts:149`)
persists a `DetectionRunSummary` into `Settings["detection_run_status"]`:
`detectorStamp`, `totalRecords`, `resolved`, `ambiguous`, `unknown`,
`confidenceBuckets` (four fixed bands), `overrideHits`, `finishedAt`. A
corrupt blob reads back as `null`, never as invented defaults.

**Review queue.** Every non-resolved record upserts a `DetectionIssue` keyed
by a deterministic sha256 fingerprint of the normalized input
(`fingerprintDetectionInput`, `detectionRun.ts:98`) — repeats bump
`occurrences` and `lastSeenAt` instead of duplicating rows. Transitions are
`OPEN → RESOLVED | IGNORED` only, claimed atomically with `updateMany`, and
every transition writes a `logAdminAction` row.

**Override-rate alarm.** If more than 5% of the catalog resolves via manual
overrides, the run emits a `logger.warn` and raises a single sentinel issue
(`__override_rate_exceeded__`) so it also shows up in the review queue
(`detectionRun.ts:193-207`).

**Purity enforcement (AC-01/AC-17).** `scripts/check-detection-engine-purity.ts`
runs in `pretest`. It scans every non-test, non-`knowledge/`, non-`__fixtures__/`
file under `detection/` and fails on `localeCompare`, `Date.now(`, zero-arg
`new Date()`, `Math.random(`, imports of `@prisma/client`/`@app/db`, and any
product-name token **derived at runtime from the `.ts` fixture files**
(`walkTsFiles`, `scripts/check-detection-engine-purity.ts:139`, matches only
`*.ts` — so adding a new `.ts` fixture automatically widens the check).
**Known gap:** the JSON data fixtures —
`__fixtures__/catalogSnapshot.json` and `__fixtures__/goldenKeys.json`,
holding all 232 real production brand names (Task 11) — are never walked by
`walkTsFiles`, so none of those real brand-name tokens ever feed the
denylist derivation; only the synthetic `.ts` fixture
(`syntheticGameA.ts`) does, confirmed by the checker's own output below ("4
product-name token(s) derived from fixtures" — all 4 come from the
synthetic `.ts` fixture, none from the 232-row real JSON data). The denylist
is **not** immune to staleness with respect to real brand names that only
ever appear in the JSON fixtures. A future improvement would extend the
derivation to also parse `.json` fixture files — not attempted here:

```
$ npx tsx scripts/check-detection-engine-purity.ts
Detection engine purity check passed: 10 file(s) scanned, 4 product-name token(s) derived from fixtures, no violations.
```

**Index lifecycle.** `getCatalogIndex(db)` (`crud/detectionIndex.ts:46`)
caches per-`Db` handle with a 30s TTL plus a composite revision key of
`detection_catalog_revision` **and** `detection_knowledge_revision`, so a
vocabulary edit invalidates the index too. `bumpCatalogRevision(db)`
(`:92`) is the invalidation primitive; it has exactly **two** call sites —
after `importDigiflazzBrand` commits
(`packages/db/src/crud/digiflazz.ts:1046`) and in the hourly Digiflazz
catalog-sync job, before `runDetectionForCatalog`
(`apps/order-bot/src/jobs/index.ts:1488`). **It is deliberately not called
from admin product mutations.** `createCatalogProduct`/`updateCatalogProduct`
(`packages/db/src/crud/catalog.ts`) do not call it — that call was added and
then reverted (`ccd1f798` → `f437d0a3`) once it became clear both functions
run inside per-row loops under their own `$transaction`s (CSV bulk-import's
`resolveOrCreateProduct`, `splitMixedDigiflazzProducts`), where a per-call
bump would serialize a `Settings` upsert across a long batch transaction and
risks two concurrent upsert(create)s P2002-aborting each other. Admin
single-mutations instead rely on the index's own 30s cache TTL to pick up
the change — see `catalog.ts`'s own comments on those two functions for the
full reasoning.

---

## 11. Test map

| Concern | File |
|---|---|
| normalization / tokenization (incl. property tests) | `normalize.test.ts`, `tokenize.test.ts` |
| feature classification, parenthetical denylist | `features.test.ts` |
| key serialization, order-independence (INV-4) | `keys.test.ts` |
| scoring arithmetic (AC-02) | `scoring.test.ts` |
| index buckets + sorting | `indexBuild.test.ts` |
| totality, determinism ×1000, `conflicts[]` | `engine.invariants.test.ts` |
| property-based totality/determinism (fast-check) | `engine.property.test.ts` |
| acceptance scenarios (7-entity set, format invariance, alias fix) | `engine.acceptance.test.ts` |
| synthetic 5-variant catalog | `engine.synthetic.test.ts` |
| 10k-entry benchmark + Map structural check | `benchmark.test.ts` |
| real-catalog `productKey` collisions | `collision.test.ts` |
| real-catalog cross-brand `skuKey` collisions | `skuKeyCollision.test.ts` |
| golden-key stability | `keyStability.test.ts` |
| knowledge validation | `knowledge/schema.test.ts` |
| DB layer | `packages/db/src/crud/detection*.test.ts` |
| purity checker itself | `scripts/check-detection-engine-purity.test.ts` |

Run the engine suite with:

```
npx vitest run packages/core/src/detection
npx vitest run --coverage packages/core/src/detection   # 90% threshold, scoped — run manually; not in pretest/CI, see §9 item 8
```
