import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// No "@" path alias here on purpose: the repo-root vitest.config.ts already
// maps "@" to apps/web-admin/client/src for the admin SPA's shadcn imports,
// so this client sticks to relative imports to avoid a second, conflicting
// alias registration.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/static/shop-app/",
  build: {
    outDir: "../static/shop-app",
    emptyOutDir: true,
  },
});
