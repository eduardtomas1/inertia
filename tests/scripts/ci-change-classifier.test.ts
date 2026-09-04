import { describe, expect, it } from "vitest";

import {
  CHANGE_DOMAINS,
  classifyChangedPaths,
  githubOutputsForClassification,
} from "../../scripts/ci/change-classifier.mjs";

describe("CI change classifier", () => {
  it("fails open for an unavailable diff, unsafe path, or unclassified path", () => {
    for (const paths of [
      [],
      ["../outside"],
      ["brand-new-root-format.xyz"],
      ["resources/runtime-contract.md"],
      ["docs/ci-hook.mjs"],
    ]) {
      const result = classifyChangedPaths(paths);
      expect(result.allEvidence).toBe(true);
      expect(result.fullCertification).toBe(true);
      expect(result.documentationOnly).toBe(false);
      expect(result.domains).toEqual(CHANGE_DOMAINS);
    }
  });

  it("only classifies an entirely documentary change as documentation-only", () => {
    expect(classifyChangedPaths([
      "README.md",
      "docs/CI_EVIDENCE.md",
      "docs/screenshots/example.png",
    ])).toEqual({
      allEvidence: false,
      fullCertification: false,
      documentationOnly: true,
      domains: [],
      reasons: [],
    });
    expect(classifyChangedPaths(["docs/guide.md", "src/renderer/src/App.tsx"]).documentationOnly)
      .toBe(false);
  });

  it("selects a provider family plus shared lifecycle evidence", () => {
    const codex = classifyChangedPaths(["src/server/provider/codex-app-server-harness.ts"]);
    expect(codex.allEvidence).toBe(false);
    expect(codex.fullCertification).toBe(false);
    expect(codex.domains).toEqual([
      "quality_shared",
      "provider_common",
      "provider_codex",
      "turn_session",
      "agent_management",
    ]);

    const shared = classifyChangedPaths(["src/server/provider/contracts.ts"]);
    expect(shared.domains).toEqual(expect.arrayContaining([
      "provider_codex",
      "provider_claude",
      "provider_cursor",
      "provider_kimi",
      "provider_opencode",
    ]));
  });

  it("unions independent known domains without escalating them", () => {
    const result = classifyChangedPaths([
      "src/renderer/src/App.tsx",
      "src/main/app-update.ts",
    ]);
    expect(result.allEvidence).toBe(false);
    expect(result.fullCertification).toBe(true);
    expect(result.domains).toEqual(expect.arrayContaining([
      "quality_shared",
      "renderer_ui",
      "updater",
      "startup_recovery",
      "windows_packaging",
      "linux_appimage",
      "macos_packaging",
    ]));
  });

  it("promotes only platform-sensitive domains to full certification", () => {
    for (const path of [
      "src/main/runtime-supervisor.ts",
      "src/main/terminal-manager.ts",
      "src/renderer/src/App.tsx",
      "benchmarks/data-throughput.test.ts",
    ]) {
      expect(classifyChangedPaths([path]).fullCertification, path).toBe(true);
    }
    for (const path of [
      "src/server/provider/claude-agent-sdk-harness.ts",
      "src/server/database.ts",
      "src/server/persistence/migrations/runtime-catalog.ts",
      "src/server/runtime/run-state-engine.ts",
      "src/server/runtime/turns/turn-controller.ts",
      "src/server/runtime/agent-thread-manager.ts",
      "src/server/runtime/commands/conversation-commands.ts",
      "docs/CI_EVIDENCE.md",
    ]) {
      expect(classifyChangedPaths([path]).fullCertification, path).toBe(false);
    }
  });

  it("routes portable turn and agent changes through every provider domain", () => {
    for (const path of [
      "src/server/runtime/turns/turn-controller.ts",
      "src/server/runtime/run-state-engine.ts",
      "src/server/runtime/agent-thread-manager.ts",
    ]) {
      const result = classifyChangedPaths([path]);
      expect(result.allEvidence, path).toBe(false);
      expect(result.fullCertification, path).toBe(false);
      expect(result.domains, path).toEqual(expect.arrayContaining([
        "provider_common",
        "provider_codex",
        "provider_claude",
        "provider_cursor",
        "provider_kimi",
        "provider_opencode",
        "turn_session",
        "agent_management",
      ]));
    }
  });

  it("keeps test infrastructure broad while routing owned test files", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "tests/support/runtime-event-queue.ts",
      "tests/server/unclassified-new-area.test.ts",
      "package-lock.json",
      "src/shared/model-routing.ts",
      "scripts/ci/change-classifier.mjs",
    ]) {
      expect(classifyChangedPaths([path]).allEvidence, path).toBe(true);
    }

    const provider = classifyChangedPaths([
      "src/server/provider/claude-agent-sdk-harness.ts",
      "tests/server/claude-agent-sdk-harness.test.ts",
    ]);
    expect(provider.allEvidence).toBe(false);
    expect(provider.fullCertification).toBe(false);
    expect(provider.domains).toEqual(expect.arrayContaining([
      "provider_common",
      "provider_claude",
      "turn_session",
      "agent_management",
    ]));

    const updater = classifyChangedPaths([
      "tests/main/app-update-handoff.test.ts",
    ]);
    expect(updater.allEvidence).toBe(false);
    expect(updater.fullCertification).toBe(true);
    expect(updater.domains).toContain("updater");
  });

  it("emits stable, explicit GitHub job outputs", () => {
    const output = githubOutputsForClassification(
      classifyChangedPaths(["src/server/provider/kimi-acp-harness.ts"]),
    );
    expect(output).toContain("all_evidence=false\n");
    expect(output).toContain("full_certification=false\n");
    expect(output).toContain("provider_kimi=true\n");
    expect(output).toContain("provider_codex=false\n");
    expect(output).toContain('domains_json=["quality_shared","provider_common","provider_kimi","turn_session","agent_management"]\n');
  });
});
