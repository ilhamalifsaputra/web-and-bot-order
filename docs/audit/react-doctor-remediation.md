# React Doctor remediation

Scope: all findings listed in `Fix exactly one React Doctor rule i.md`, across `@app/web-admin-client` and `@app/storefront-client`. The repeated single-rule sections were each checked against the baseline; their union contains 28 rules and 320 findings.

React Doctor 0.9.17: admin 225 -> 0; storefront 95 -> 0. Both full-project scans completed with no skipped checks. Canonical documentation for all 28 rules was fetched with cache disabled and reviewed before applying the fixes. No rules were suppressed or disabled.

| Rule (canonical documentation) | Admin before | Storefront before | After, both projects |
| --- | ---: | ---: | ---: |
| [anchor-has-content](https://react.doctor/docs/rules/react-doctor/anchor-has-content) | 0 | 1 | 0 |
| [async-await-in-loop](https://react.doctor/docs/rules/react-doctor/async-await-in-loop) | 1 | 0 | 0 |
| [click-events-have-key-events](https://react.doctor/docs/rules/react-doctor/click-events-have-key-events) | 1 | 0 | 0 |
| [control-has-associated-label](https://react.doctor/docs/rules/react-doctor/control-has-associated-label) | 0 | 1 | 0 |
| [duplicate-jsx-subtree](https://react.doctor/docs/rules/react-doctor/duplicate-jsx-subtree) | 7 | 0 | 0 |
| [exhaustive-deps](https://react.doctor/docs/rules/react-doctor/exhaustive-deps) | 3 | 1 | 0 |
| [js-hoist-intl](https://react.doctor/docs/rules/react-doctor/js-hoist-intl) | 0 | 1 | 0 |
| [js-set-map-lookups](https://react.doctor/docs/rules/react-doctor/js-set-map-lookups) | 3 | 1 | 0 |
| [label-has-associated-control](https://react.doctor/docs/rules/react-doctor/label-has-associated-control) | 113 | 0 | 0 |
| [no-adjust-state-on-prop-change](https://react.doctor/docs/rules/react-doctor/no-adjust-state-on-prop-change) | 5 | 2 | 0 |
| [no-array-index-as-key](https://react.doctor/docs/rules/react-doctor/no-array-index-as-key) | 4 | 18 | 0 |
| [no-create-object-url-in-render](https://react.doctor/docs/rules/react-doctor/no-create-object-url-in-render) | 0 | 2 | 0 |
| [no-create-object-url-without-revoke](https://react.doctor/docs/rules/react-doctor/no-create-object-url-without-revoke) | 1 | 2 | 0 |
| [no-derived-useState](https://react.doctor/docs/rules/react-doctor/no-derived-useState) | 0 | 1 | 0 |
| [no-effect-chain](https://react.doctor/docs/rules/react-doctor/no-effect-chain) | 1 | 2 | 0 |
| [no-giant-component](https://react.doctor/docs/rules/react-doctor/no-giant-component) | 20 | 8 | 0 |
| [no-high-complexity-react-function](https://react.doctor/docs/rules/react-doctor/no-high-complexity-react-function) | 26 | 19 | 0 |
| [no-ref-current-in-render](https://react.doctor/docs/rules/react-doctor/no-ref-current-in-render) | 1 | 1 | 0 |
| [no-side-effect-in-state-updater-function](https://react.doctor/docs/rules/react-doctor/no-side-effect-in-state-updater-function) | 1 | 2 | 0 |
| [no-static-element-interactions](https://react.doctor/docs/rules/react-doctor/no-static-element-interactions) | 1 | 0 | 0 |
| [no-transition-all](https://react.doctor/docs/rules/react-doctor/no-transition-all) | 8 | 0 | 0 |
| [no-unguarded-numeric-input-parse](https://react.doctor/docs/rules/react-doctor/no-unguarded-numeric-input-parse) | 0 | 1 | 0 |
| [only-export-components](https://react.doctor/docs/rules/react-doctor/only-export-components) | 14 | 14 | 0 |
| [prefer-dynamic-import](https://react.doctor/docs/rules/react-doctor/prefer-dynamic-import) | 2 | 0 | 0 |
| [query-mutation-missing-invalidation](https://react.doctor/docs/rules/react-doctor/query-mutation-missing-invalidation) | 4 | 4 | 0 |
| [rerender-lazy-state-init](https://react.doctor/docs/rules/react-doctor/rerender-lazy-state-init) | 3 | 3 | 0 |
| [rerender-state-only-in-handlers](https://react.doctor/docs/rules/react-doctor/rerender-state-only-in-handlers) | 3 | 0 | 0 |
| [use-lazy-motion](https://react.doctor/docs/rules/react-doctor/use-lazy-motion) | 3 | 11 | 0 |

## Changes and regression coverage

- Split large components and independent control-flow branches into named components, hooks, and pure helpers; separate non-component exports for Fast Refresh.
- Associate labels and controls, add keyboard activation to mobile table cards, and preserve focus ownership in dialogs/search.
- Use stable identities for editable rows; retain separate Premium Apps and Game Top Up fields and existing stored metadata.
- Scope form/pricing state to its owning selection; reject stale pricing/action completions; preserve account answers across equivalent denomination schemas.
- Keep SSE subscriptions stable while using the latest committed merge callback.
- Create preview URLs in effects and revoke each URL on replacement/unmount, including Strict Mode replay.
- Load charts on demand, use LazyMotion, narrow CSS transitions, cache relative-time formatters, and guard numeric input parsing.
- Keep imperative email/resend/reveal requests outside the query cache; invalidate query data for mutations that change cached state.
- Replace the stock replacement serial loop with a maximum of two independent requests. Backend allocation locks each order unit and skips locked stock; report outcomes in input order.

Focused regression tests cover dialog reopening, stale action completions/reset/unmount, keyboard-only row activation, editable-row identity after removal, search selection after result changes, SSE callback replacement without reconnection, preview cleanup, and bounded stock-request concurrency. Existing checkout, instant-buy, family separation, voucher, and delivery tests were also run during iteration.

## Verification

The feature branch was fetched and rebased onto local `master` before the full validation gate. Build: `pnpm -r build` passed.

For this worktree, the isolated Postgres container is `admin-react-doctor-all-postgres` on port 5549. Its credentials are stored only in the ignored worktree `.env`. The container was stopped after verification; use `docker start admin-react-doctor-all-postgres` before running database tests again. The test precondition is `pnpm exec prisma db push --skip-generate` against that database; most suites create temporary schemas, but the integrity suite checks the dev database directly.

```powershell
npx --yes react-doctor@latest --project @app/web-admin-client,@app/storefront-client --verbose --no-score --no-supply-chain --no-cache --no-parallel --json --json-out <report.json>
pnpm typecheck
pnpm test
```

Full typecheck: passed. Final full suite: **615 test files passed; 11,474 tests passed** (674.09 seconds). All pretest gates passed: migration drift, migration timestamps, frontend boundaries, storefront lint, and detection engine purity.

Final no-cache React Doctor scan: version 0.9.17, full mode, code revision `23e0cbdb`; admin 316 source files and zero diagnostics, storefront 301 source files and zero diagnostics, with empty `skippedChecks` arrays for both projects.

The first full run passed 614/615 test files; four assertions in `packages/db/src/crud/integrity.test.ts` failed because the fresh session database had no tables in its `public` schema. That suite explicitly requires `prisma db push` against the dev database. After initializing only the isolated session database, all five tests in that file passed; no application or test code was changed for this environment correction. The full suite was then rerun and passed completely.

The integration checkout contains an untracked `skills-lock.json`; per repository rules it must be clean before merging. Its file was left untouched.
