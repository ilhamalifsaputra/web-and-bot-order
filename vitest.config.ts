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
    environmentMatchGlobs: [["apps/web-admin/client/**", "jsdom"]],
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
