import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function connectServiceWorkerPrecache() {
  let outputDirectory;
  return {
    name: "pixice-connect-service-worker-precache",
    apply: "build",
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const workerPath = path.join(outputDirectory, "connect-sw.js");
      if (!fs.existsSync(workerPath)) return;
      const staticFiles = [];
      const visit = (directory, prefix = "") => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(absolute, relative);
          else if (relative !== "connect-sw.js") staticFiles.push(`/${relative}`);
        }
      };
      visit(outputDirectory);
      const shell = [...new Set(["/index.html", "/manifest.webmanifest", "/pixice-icon-192.png", "/pixice-icon-512.png", ...staticFiles.sort()])];
      const source = fs.readFileSync(workerPath, "utf8");
      const buildHash = createHash("sha256").update(source).update(shell.join("\n"));
      for (const file of shell) buildHash.update(fs.readFileSync(path.join(outputDirectory, file.slice(1))));
      const buildId = buildHash.digest("hex").slice(0, 16);
      const replacements = [
        ["__PIXICE_PRECACHE__", JSON.stringify(shell)],
        ["__PIXICE_BUILD_ID__", JSON.stringify(buildId)],
      ];
      let replaced = source;
      for (const [token, value] of replacements) {
        const occurrences = replaced.split(token).length - 1;
        if (occurrences !== 1) throw new Error(`Expected one ${token} token in the Connect service worker, found ${occurrences}.`);
        replaced = replaced.replace(token, value);
      }
      if (replaced.includes("__PIXICE_PRECACHE__") || replaced.includes("__PIXICE_BUILD_ID__")) throw new Error("Connect service worker build tokens were not fully replaced.");
      fs.writeFileSync(workerPath, replaced, "utf8");
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Electron loads index.html from disk; Sites serves client routes from the
  // origin root, so each target needs a distinct asset base.
  base: mode === "desktop" ? "./" : "/",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["motion/react", "react", "react-dom/client"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), connectServiceWorkerPrecache()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    exclude: ["tests/sites-worker.test.mjs", "node_modules/**", "dist/**"],
  },
}));
