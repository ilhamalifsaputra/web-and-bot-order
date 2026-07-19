import path from "node:path";
import { defineConfig } from "vitest/config";

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
    env: { BCRYPT_COST: "4" },
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
    // `node:sqlite` is a recent built-in not yet in Vite's auto-externalised
    // builtins list — externalise it so vite-node leaves the import alone.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
});
