import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  // Electron loads index.html from disk; Sites serves client routes from the
  // origin root, so each target needs a distinct asset base.
  base: mode === "desktop" ? "./" : "/",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    exclude: ["tests/sites-worker.test.mjs", "node_modules/**", "dist/**"],
  },
}));
