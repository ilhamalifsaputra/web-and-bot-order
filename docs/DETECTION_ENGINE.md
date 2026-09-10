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
| Changing it means | a deploy + a `DETECTOR_VERSION` bump if keys can move | a DB row (admin panel / seed script) |
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
  `knowledge.externalIdStableBySupplier[supplier] === true`. If a supplier's
  ids turn out not to be stable, flip that flag in the knowledge base — the
  signal drops out without any code change.

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

Admin/programmatic path (each audits via `logAdminAction` and bumps
`detection_knowledge_revision`, which invalidates both caches):

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

You almost never touch engine code. In order of preference:

**Step 1 — Do nothing and check.** Most names already work. Run the row
through the engine:

```
npx tsx scripts/detection-key-diff.ts     # compares engine grouping vs. legacy digiflazzGroupKey
```

or read the review queue in the admin panel (Digiflazz Sync → "Deteksi").
If the name already resolves to the right `productKey`, you are done.

**Step 2 — Is a word being classified wrongly (or not at all)?** Add or edit
a `DetectionToken` row. Pick the category (`platform`/`edition`/
`distribution`/`region`/`noise`) and, critically, `isProductDefining`:
`true` means the word creates a *different product*, `false` means it only
distinguishes a SKU/region of the same product. Region words are `false`.
This changes both grouping and keys for every row containing that word.

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

**Step 5 — Make the change take effect, and prove it.**

```
pnpm seed-detection-knowledge                 # REQUIRED if you edited defaultVocabulary.ts
npx vitest run packages/core/src/detection    # keyStability.test.ts will flag any key drift
npx tsx scripts/recompute-detection-keys.ts   # dry-run: shows exactly which keys moved
```

If keys moved on purpose: bump `DETECTOR_VERSION` when the cause was engine
logic, regenerate `goldenKeys.json` with `--apply`, review the diff, and
commit both together.

Only if none of steps 2-4 can express the fix (for example: a *multi-word*
region such as "Hong Kong", which per-word tokenization cannot classify) do
you change `features.ts` — and then you are changing the engine, which means
a `DETECTOR_VERSION` bump and a full golden-key review.

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
   transaction. A crash mid-loop leaves a product partially stamped; the next
   hourly `runDetectionForCatalog` heals it. `bumpCatalogRevision` at
   `crud/digiflazz.ts:1046` is likewise unguarded — a failure there just means
   the index waits out its 30s TTL.
7. **`DetectionOverride.hitCount` is declared but never incremented.** The
   run-level `overrideHits` count in the metrics blob is real; the per-row
   counter is currently a dead column.
8. **Coverage is enforced at 90% for `packages/core/src/detection/**` only**,
   not repo-wide (`vitest.config.ts` `coverage.thresholds`). No coverage
   tooling existed in this repo before this work; retrofitting a global
   threshold is a separate project. This was an explicit, approved trade-off.
9. **Keys are opaque.** `baseProductKey` for "MOBILE LEGENDS" is `"legends"`,
   because `mobile` is a platform token. Never render a detection key to a
   buyer or an admin as a product name.

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
product-name token **derived at runtime from the fixture files** (so adding a
fixture automatically widens the check — the denylist can never go stale):

```
$ npx tsx scripts/check-detection-engine-purity.ts
Detection engine purity check passed: 10 file(s) scanned, 4 product-name token(s) derived from fixtures, no violations.
```

**Index lifecycle.** `getCatalogIndex(db)` (`crud/detectionIndex.ts:46`)
caches per-`Db` handle with a 30s TTL plus a composite revision key of
`detection_catalog_revision` **and** `detection_knowledge_revision`, so a
vocabulary edit invalidates the index too. `bumpCatalogRevision(db)`
(`:92`) is the invalidation primitive; it is called after
`importDigiflazzBrand` commits and from admin product creation.

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
npx vitest run --coverage packages/core/src/detection   # 90% threshold, scoped
```
