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
          "conversation-attachment-store-worker": resolve(
            "src/main/conversation-attachment-store-worker.ts",
          ),
          "attachment-import-worker": resolve(
            "src/main/attachment-import-worker.ts",
          ),
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
        input: {
          index: resolve("src/preload/index.ts"),
          "detached-chat": resolve("src/preload/detached-chat.ts"),
          "preview-agent-privacy": resolve("src/preload/preview-agent-privacy.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
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
      minify: "terser",
      terserOptions: {
        compress: {
          passes: 2,
        },
      },
      sourcemap: false,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 850,
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
        output: {
          onlyExplicitManualChunks: true,
          chunkFileNames({ name }) {
            const compactNames: Record<string, string> = {
              attentionVisibility: "chat",
              "terminal-turn-projection": "turn",
              timelineFocus: "focus",
              "archive-restore": "restore",
              workspaceFileReference: "file-ref",
            };
            return `assets/${compactNames[name] ?? name}-[hash].js`;
          },
          manualChunks(id) {
            const normalizedId = id.replaceAll("\\", "/");
            if (normalizedId.includes("/node_modules/morphicons/")) {
              return "morphicons";
            }
            if (normalizedId.endsWith(
              "/src/renderer/src/utils/terminalTurnProjection.ts",
            )) return "terminal-turn-projection";
          },
        },
      },
    },
  },
});
