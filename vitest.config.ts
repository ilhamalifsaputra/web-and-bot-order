import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    environmentMatchGlobs: [["apps/web-admin/client/**", "jsdom"]],
    // @testing-library/jest-dom's main export calls `expect.extend(...)`
    // referencing a bare global `expect` at module load time (no Vitest-
    // specific subpath export exists in this version) — it cannot work
    // without globals enabled. Every existing test file already imports
    // describe/it/expect explicitly from "vitest", so this changes nothing
    // for them; it only makes jest-dom's auto-extend possible.
    globals: true,
    // `node:sqlite` is a recent built-in not yet in Vite's auto-externalised
    // builtins list — externalise it so vite-node leaves the import alone.
    server: { deps: { external: [/^node:sqlite$/] } },
  },
});
