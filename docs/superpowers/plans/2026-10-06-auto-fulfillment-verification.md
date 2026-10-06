# Automatic fulfillment verification — 2026-10-06

## Result

Digiflazz purchases route by explicit provider metadata, independently of the delivery type used to collect buyer input. Purchased provider/SKU are frozen on new orders. Legacy orders use explicit catalog metadata as a fallback. The existing provider client, stable order reference, three-minute dispatch lease, bounded 24-hour reconciliation window, webhook authentication and live supplier recheck remain in place.

Digiflazz purchases require exactly one order line, including products configured as AUTO. Shared cart guards and the order-creation boundary reject mixed supplier/stock carts before creating an order or reserving stock. Historical mixed orders require review before any supplier request, preventing one supplier receipt from marking unrelated stock delivered.

Successful automatic orders enqueue no manual-processing buyer DM, manual-queue admin alert or owner manual-queue/paid email. Terminal provider incidents commit their state and deduplicated admin outbox rows together. Missing credentials require review. Ordinary manual fulfillment and explicit admin resends remain available; automatic orders cannot be hand-delivered while a supplier transaction is in flight.

The account API and SSE publish a shared buyer-safe fulfillment projection. Website status follows full detail refetches, with five-second polling as a fallback. Game ID edits use a guarded database write and stop when dispatch is claimed. Desktop order details use a full-width content region and 320px summary; mobile cards stack and wrap long identifiers. Both languages and monetary rows are preserved.

Telegram stores one status message per paid order. Guarded send/edit leases survive restart, spinner frames change every two seconds, successful delivery finishes the message, and review pauses the spinner while watching for resolution. Deleted messages are not replaced automatically. Flood control defers work. An ambiguous initial send stops automatic resend and records one separate transport incident: Telegram has no idempotent initial-send API. Status messages use the main bot and contain escaped item names, without buyer targets, credentials or provider secrets. Combined-server and standalone-bot startup/shutdown both run the worker.

## Verification

All database integration tests use the dedicated local test PostgreSQL container on port 55449, with isolated databases/schemas and fake supplier/Telegram APIs. The local Vitest wrapper sets the test database URL and uses the existing root configuration.

| Check | Command | Result |
| --- | --- | --- |
| Full integration regression | `node node_modules/vitest/vitest.mjs run --config .audit-data/auto-fulfillment.vitest.config.ts --maxWorkers=6 --minWorkers=1 --reporter=json --outputFile=.audit-data/auto-fulfillment-merge-tests.json` | 10,087 passed of 10,095; one obsolete cart assertion and seven timeouts, resolved by the rerun below |
| Integration rerun | Same runner, all seven affected files: dispatcher, Digiflazz, orders, storefront API, admin web, bot handlers and bot jobs; four workers; `.audit-data/auto-fulfillment-merge-rerun-tests.json` | All 1,492 tests passed; zero failed suites |
| Final provider/callback regression | Same runner, `packages/db/src/crud/automaticFulfillment.test.ts`, `packages/db/src/crud/digiflazz.test.ts`, `apps/storefront/test/digiflazz-webhook.test.ts` | All 175 tests passed, including both previously failing cases |
| Callback/projection/startup compatibility | Same runner, six callback, route lookup, payment bubble and startup files | 94 tests passed |
| Telegram/outbox package | Same runner, `packages/outbox-dispatcher` | 168 tests passed, including 12 worker regressions |
| Workspace types | `node node_modules/typescript/bin/tsc -p <package>/tsconfig.json --noEmit` for all nine package/application configurations | Passed |
| Test types | `node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit` | Passed |
| Storefront lint | `node node_modules/eslint/bin/eslint.js .` in `apps/storefront/client` | Passed |
| Storefront build | `node node_modules/vite/bin/vite.js build` in `apps/storefront/client` | Passed |
| Admin build | Same command in `apps/web-admin/client` | Passed |
| Combined server bundle | `node node_modules/tsx/dist/cli.mjs scripts/build-bundle.ts` | Passed |
| Prisma generation | `node node_modules/prisma/build/index.js generate` | Passed |
| Migration drift | `node node_modules/tsx/dist/cli.mjs scripts/check-migration-drift.ts` with the isolated test database URL | No difference detected |
| Migration timestamps | `node node_modules/tsx/dist/cli.mjs scripts/check-migration-timestamps.ts` | 28 migrations, no collisions |
| Frontend boundaries | `node node_modules/tsx/dist/cli.mjs scripts/check-frontend-boundaries.ts` | Passed |
| Detection purity | `node node_modules/tsx/dist/cli.mjs scripts/check-detection-engine-purity.ts` | Passed |
| Diff formatting | `git diff --check` | Passed |

Red/green regressions cover automatic notification suppression, frozen routing/SKU after catalog edits, local-stock bypass for explicit suppliers, duplicate settlement/dispatch, edit locking, delivered item status, terminal incident deduplication, transactional alert failure, missing credentials, cancellation and credit-balance presentation. Additional cases cover legacy callback orders without an existing tracking row and an injected PostgreSQL item-update failure: receipt, delivery state, items and message tracking now commit together, so an interrupted write stays retryable with the original supplier reference. Mixed-cart regressions verify rejection at cart addition, checkout and order creation, plus review of historical mixed orders before supplier dispatch. Worker tests cover initial send and competing workers, saved-message restart, terminal stop, review resolution, stale sending/editing leases, send/edit flood control, unavailable messages, unchanged terminal edits and escaped item names.

The complete integration suite exercised the final production code. One historical storefront assertion was updated to expect rejection of mixed AUTO/Digiflazz carts. Timeout records include a roughly 42-minute execution interruption; all seven affected files were rerun successfully with unchanged production code. The JSON rerun reports 1,492 passed, zero failed and success=true. Windows PowerShell reports redirected Vite stderr warnings as NativeCommandError; a controlled cart-suite invocation confirmed Vitest exits zero when its actual LASTEXITCODE is preserved. The core cart suite also passed with that explicit exit-code check. Successful full-suite results plus the affected-file rerun cover all 10,095 tests; the complete suite was not repeated after the test-only assertion update.

Chromium smoke verification at 375px and 1440px showed no horizontal overflow, a 320px desktop summary and controls at least 44px high. Local screenshots and the smoke script are under `apps/storefront/client/.tmp/`. Final client builds retain the existing chunk-size and mixed static/dynamic import warnings.

## Deployment and practical limits

The additive migration is `prisma/migrations/20261006120000_automatic_fulfillment/migration.sql`: nullable order provider/SKU snapshots and the fulfillment-message table/indexes. No existing business-status enum or payment schema is replaced. The standalone bot adds a dependency on the existing workspace worker package; frozen-lockfile offline installation passed and downloaded no new packages.

Docker retains the existing combined-server image and in-process workers; no new container, queue or service is required. The Dockerfile already generates Prisma, builds both clients and starts the combined server. Its existing entrypoint applies the schema before application startup. The actual image was not rebuilt or deployed during this task.

Database changes were exercised only against isolated test databases. The active application database has not been migrated, and no real supplier purchase, customer Telegram message or deployment was performed. The user separately authorized committing and synchronizing local master with origin/master. Apply through the repository's normal deployment/migration process before enabling the new application version. Validate a real provider pending-to-success transition and Telegram delivery with a controlled test order after deployment.

Read-only review found no remaining critical issue in worker claims, restart/flood handling, main-bot ownership, lifecycle wiring or mixed-cart supplier routing. Unrelated user icon deletions and existing audit/config files were preserved.
