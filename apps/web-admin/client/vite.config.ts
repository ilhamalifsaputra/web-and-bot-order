import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/static/dashboard-app/",
  build: {
    outDir: "../static/dashboard-app",
    emptyOutDir: true,
  },
});
