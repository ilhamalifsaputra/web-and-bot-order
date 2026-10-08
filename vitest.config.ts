import path from "node:path";
import { defineConfig } from "vitest/config";

// Matches `glob` under any directory of an absolute changed-file path,
// including dot-directories such as `.claude/worktrees/<topic>`.
const anywhere = (glob: string) => `{**/,**/.*/**/}${glob}`;

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors apps/web-admin/client/vite.config.ts's "@" alias (and the
      // matching tsconfig "paths") so shadcn-generated components under
      // apps/web-admin/client/src (e.g. ui/card.tsx's "@/lib/utils" import)
      // resolve correctly when Vitest runs from the repo root.
      "@": path.resolve(__dirname, "./apps/web-admin/client/src"),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    // bcryptjs at the production work factor (12) costs ~450ms per hash and
    // ~500ms per compare, which is real time inside every auth test — enough
    // that the storefront's cross-IP account-lockout test spent ~3s in bcrypt
    // and intermittently blew Vitest's 5s default timeout under a loaded
    // parallel run. Set here rather than in each app's test/setup-env.ts so it
    // also covers suites with no env bootstrap (e.g. packages/core). Only
    // honoured when running under Vitest — see packages/core/src/password.ts,
    // where the production cost is a hard constant.
    // CREDENTIAL_ENCRYPTION_KEY: a fixed 32-byte-hex test key for
    // @app/core/credentialCrypto (StockItem.credentials encryption, Task 2)
    // so every suite gets a working key without needing its own env
    // bootstrap — same rationale as BCRYPT_COST above. Not a real secret;
    // never use this value outside tests.
    env: { BCRYPT_COST: "4", CREDENTIAL_ENCRYPTION_KEY: "00".repeat(32) },
    // Vitest's 5s default is a unit-test budget, but most of this suite is
    // real-Postgres integration tests: tests/helpers/testdb.ts gives every test
    // file its own temp DB (so there is no cross-file lock contention to
    // hide here) and each one pays for building that schema (an in-database
    // copy of the run's template, see tests/helpers/schemaFromTemplate.ts)
    // plus real fsync-bound writes. The heavy ones therefore cost seconds of honest
    // work — the 270-unit cart in packages/db/src/crud/order_creation.test.ts
    // takes ~3.0s on its own and the /setup/owner retry in
    // apps/web-admin/test/web.test.ts ~2.3s — leaving under 2x headroom
    // against 5s. That margin is spent by CPU/IO contention as soon as the
    // suite grows: adding the Reviews-dashboard and broadcast test files
    // tipped both of those past 5s in a full parallel run while each still
    // passed comfortably in isolation. Two tests in UsersPage.test.tsx had
    // already been hand-patched with `}, 10000)` for the same reason, so
    // budget it once here instead of re-discovering it per test. 20s is
    // ~6x the slowest known test: still short enough that a genuine hang
    // fails the run rather than hanging CI.
    testTimeout: 20_000,
    // Vitest's 10s hook default is too short for the one hook per run that
    // builds the test-schema template (db push + chart-of-accounts seed +
    // migrate diff, ~15s idle and more under load), and for the beforeAll
    // hooks in the other workers that wait on that build's advisory lock:
    // makeTestDb() runs inside a test file's beforeAll, so on a loaded machine
    // the files that arrive first would time out waiting rather than fail for
    // a real reason. 180s still fails a genuinely hung hook.
    hookTimeout: 180_000,
    // `vitest run --changed master` (pnpm test:changed) only reruns tests whose
    // import graph touches a changed file. Some inputs reach nearly every test
    // without being visible in that graph: the Prisma schema (every DB test
    // builds its schema from it), the shared test helpers, each app's
    // setup-env.ts (a safety net; tests import it), config files, and the
    // lockfile. Files that tests read from disk instead of importing are
    // invisible too: detection `__fixtures__` and the i18n locale JSON that
    // packages/core/src/i18n.ts loads with readFileSync. Editing any of these
    // falls back to the full suite instead of silently running nothing.
    // Vitest matches these globs against absolute paths, and every worktree
    // lives under `.claude/`, which micromatch's `**` skips by default, so
    // `anywhere` adds a dot-directory-crossing alternative. The first three
    // entries are Vitest's own defaults, repeated because setting this option
    // replaces them.
    forceRerunTriggers: [
      "package.json",
      "vitest.config.*",
      "vite.config.*",
      "prisma/schema.prisma",
      "tests/helpers/**",
      "test/setup-env.ts",
      "pnpm-lock.yaml",
      "__fixtures__/**",
      "packages/core/locales/*.json",
    ].map(anywhere),
    // Names this run's template Postgres schema; the first test file that
    // needs a database builds it (db push + chart-of-accounts seed, once) and
    // tests/helpers/testdb.ts and pgTestSchema.ts copy each file's schema from
    // it in-database instead of spawning those two commands for every file.
    // Runs without DB tests (guard runs, jsdom client runs) do no template
    // work, though this file's globalSetup still runs and only picks the name. See
    // tests/helpers/globalSetup.ts and schemaFromTemplate.ts.
    globalSetup: ["tests/helpers/globalSetup.ts"],
    environmentMatchGlobs: [
      ["apps/web-admin/client/**", "jsdom"],
      ["apps/storefront/client/**", "jsdom"],
    ],
    // @testing-library/react's automatic afterEach(cleanup) only registers
    // when it detects a global test-framework `afterEach` — without this,
    // each jsdom test's rendered DOM leaks into the next test in the same
    // file (verified: "renders a single currency" failed with "Found
    // multiple elements" because the prior test's render() was still in
    // document.body). This also lets @testing-library/jest-dom's bare
    // import extend a global `expect` at module load time. Every existing
    // test file already imports describe/it/expect explicitly from
    // "vitest", so this changes nothing for them.
    globals: true,
    // No coverage tooling existed in this repo before the detection engine
    // (docs/arsitektur/DETECTION_ENGINE.md "Baseline"). Global coverage is recorded for
    // visibility but NOT enforced — retrofitting a threshold onto a decade of
    // untested code is a separate, unrelated project. The threshold below is
    // scoped to only the new engine, where 100% test-first coverage is a
    // realistic bar this change actually earns.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        "packages/core/src/detection/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
