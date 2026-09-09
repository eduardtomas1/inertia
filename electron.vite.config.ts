import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { lifecycleBuildMetadataFromEnvironment } from
  "./src/shared/lifecycle-build-metadata";

const windowsRuntimeJobIntegrityPath = resolve(
  "resources/generated/windows-runtime-job-integrity.json",
);

function readWindowsRuntimeJobIntegrity(): { readonly sha256: string | null } {
  const value: unknown = JSON.parse(readFileSync(
    windowsRuntimeJobIntegrityPath,
    "utf8",
  ));
  if (
    !value
    || typeof value !== "object"
    || Object.keys(value).length !== 1
    || !("sha256" in value)
    || (value.sha256 !== null
      && (typeof value.sha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(value.sha256)))
  ) throw new Error("The Windows runtime Job Object integrity manifest is invalid.");
  return { sha256: value.sha256 };
}

// Capture once. The compiled constant and emitted package-gate snapshot are
// therefore guaranteed to describe the same source manifest.
const bundledWindowsRuntimeJobIntegrity = readWindowsRuntimeJobIntegrity();

function checkedOutBuildRevision(): string | undefined {
  if (process.env.GITHUB_ACTIONS !== "true") return undefined;
  try {
    const revision = execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      {
        encoding: "utf8",
        maxBuffer: 1_024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    ).trim().toLowerCase();
    return /^[0-9a-f]{40}$/u.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

const bundledLifecycleBuildMetadata = lifecycleBuildMetadataFromEnvironment(
  {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_SHA: checkedOutBuildRevision() ?? process.env.GITHUB_SHA,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_REF_TYPE: process.env.GITHUB_REF_TYPE,
    GITHUB_REF_NAME: process.env.GITHUB_REF_NAME,
  },
);

export default defineConfig({
  main: {
    define: {
      __INERTIA_BUILD_METADATA__: JSON.stringify(
        bundledLifecycleBuildMetadata,
      ),
      __INERTIA_WINDOWS_RUNTIME_JOB_SHA256__: JSON.stringify(
        bundledWindowsRuntimeJobIntegrity.sha256,
      ),
    },
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "windows-runtime-job-integrity-snapshot",
        generateBundle() {
          this.emitFile({
            fileName: "windows-runtime-job-bundled-integrity.json",
            source: `${JSON.stringify(bundledWindowsRuntimeJobIntegrity, null, 2)}\n`,
            type: "asset",
          });
        },
      },
    ],
    build: {
      target: "node22",
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "snapshot-capture-worker": resolve("src/main/snapshot-capture-worker.ts"),
          "snapshot-binding-worker": resolve("src/main/snapshot-binding-worker.ts"),
          "snapshot-shortcut-worker": resolve("src/main/snapshot-shortcut-worker.ts"),
          "runtime-worker": resolve("src/server/runtime-worker.ts"),
          "message-search-worker": resolve("src/server/persistence/message-search-worker.ts"),
          "app-update-candidate-viability-worker": resolve(
            "src/server/app-update-candidate-viability-worker.ts",
          ),
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
          mascot: resolve("src/preload/mascot.ts"),
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
        input: { index: resolve("src/renderer/index.html"), mascot: resolve("src/renderer/mascot.html") },
        output: {
          onlyExplicitManualChunks: true,
          chunkFileNames({ name }) {
            const compactNames: Record<string, string> = {
              attentionVisibility: "chat",
              BrowserEvidenceTimeline: "evidence",
              "external-link": "link",
              "terminal-turn-projection": "turn",
              timelineFocus: "focus",
              "archive-restore": "restore",
              workspaceFileReference: "file-ref",
            };
            // Preserve feature names consumed by the bundle gates. Short utility
            // names reduce repeated import/preload metadata without changing code.
            const budgetedChunks = new Set([
              "App", "DetachedChatApp", "FilesPanel", "ResponseTimeline", "ResponseMarkdown", "SettingsView",
              "MascotSettings", "IssueReportSettings", "DiagnosticsSettings", "ProjectSettings", "ConversationActionsMenu", "PreMergeConfidenceLauncher", "TerminalPanel", "PreviewPanel",
              "ProviderAuthDialog", "ProviderMaintenanceNotice", "ComposerQueuedActions", "ComposerSendActions",
              "DiscordSettings", "DocumentAttachmentPreview", "AppUpdateNotice", "CanaryRollbackSetting",
              "LifecycleIntegritySettings", "failurePanel", "evidence", "morphicons", "pdf", "xlsx",
              "WorkspaceBranchMenu", "WorkspaceGitActionMenu", "application-diagnostics",
            ]);
            const label = compactNames[name] ?? (budgetedChunks.has(name) ? name : null);
            return `assets/${label ? `${label}-` : ""}[hash].js`;
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
