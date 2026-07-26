import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

describe("cross-platform packaged behavior contract", () => {
  it("keeps build, Electron E2E, fuse verification, and native smoke on all three CI platforms", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    for (const expected of [
      "runner: ubuntu-24.04",
      "runner: windows-2025",
      "runner: macos-15",
      "run: npm run check",
      "run: npm exec -- playwright test",
      "run: xvfb-run --auto-servernum npm exec -- playwright test",
      "run: npm run dist:dir",
      "run: npm run dist:linux",
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("keeps one native smoke implementation for macOS, Windows, and Linux runtime supervision", async () => {
    const smoke = await source("scripts/package-smoke.mjs");
    expect(smoke).toContain('process.platform === "darwin"');
    expect(smoke).toContain('process.platform === "win32"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain("runtimePid === mainPid");
    expect(smoke).toContain("runtime-stopped");
    expect(smoke).toContain("process-group cleanup");
    expect(smoke).toContain("Packaged Codex Ω (npm shim)");
    expect(smoke).toContain('type: "provider.refresh"');
  });

  it("keeps exact-tag release packages and smoke validation aligned across every platform", async () => {
    const workflow = await source(".github/workflows/release-platforms.yml");
    for (const expected of [
      'tags:',
      '- "v*.*.*"',
      "dist_script: dist:mac",
      "dist_script: dist:win",
      "dist_script: dist:linux",
      "node scripts/validate-release.mjs",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
      "codesign --verify --deep --strict",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("runs the real Kimi suite only when its CI secret is explicitly available", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow).toContain("Run opt-in Kimi through Claude integration");
    expect(workflow).toContain(
      "INERTIA_KIMI_CODE_API_KEY: ${{ secrets.INERTIA_KIMI_CODE_API_KEY }}",
    );
    expect(workflow).toContain('if [[ -z "${INERTIA_KIMI_CODE_API_KEY:-}" ]]');
    expect(workflow).toContain("INERTIA_RUN_KIMI_CLAUDE_INTEGRATION=1");
    expect(workflow).toContain(
      "vitest run tests/server/kimi-claude-real-smoke.test.ts",
    );
  });
});
