import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The shop's own version, shown in the nav drawer's trust footer. Read from the
// repo manifest at build time so the number can never drift from what shipped;
// under vitest there's no Vite define, and the footer omits the line rather
// than display a made-up version.
const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

// No "@" path alias here on purpose: the repo-root vitest.config.ts already
// maps "@" to apps/web-admin/client/src for the admin SPA's shadcn imports,
// so this client sticks to relative imports to avoid a second, conflicting
// alias registration.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(version) },
  base: "/static/shop-app/",
  build: {
    outDir: "../static/shop-app",
    emptyOutDir: true,
  },
});
