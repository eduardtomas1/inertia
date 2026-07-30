import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname),
  publicDir: false,
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [resolve(import.meta.dirname, "../..")],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
