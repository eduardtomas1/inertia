import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: "node22",
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "runtime-worker": resolve("src/server/runtime-worker.ts"),
          "runtime-status-cli": resolve("src/server/runtime-status-cli.ts"),
          "database-recovery-import-worker": resolve(
            "src/server/persistence/database-recovery-import-worker.ts",
          ),
          "secure-file-worker": resolve("src/main/secure-file-worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: "node22",
      sourcemap: false,
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      target: "chrome150",
      minify: "esbuild",
      sourcemap: false,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 850,
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
  },
});
