import { resolve } from "node:path";

import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      target: "node22",
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "runtime-status-cli": resolve("src/server/runtime-status-cli.ts"),
        },
      },
    },
  },
});
