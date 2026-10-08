import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/static/dashboard-app/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Patched esbuild correctly marks Safari14 destructuring as unsupported.
    // Keep the other Vite6 browser targets; Safari14.1 fixes that engine bug.
    target: ["es2020", "chrome87", "edge88", "firefox78", "safari14.1"],
    outDir: "../static/dashboard-app",
    emptyOutDir: true,
  },
});
