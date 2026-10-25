import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-provider-metadata-versions-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

describe("provider metadata scope versions", () => {
  it("keeps only the newest saved CLI version of each provider model scope", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const saved = (
      modelId: string,
      version: string,
      authState: "authenticated" | "unauthenticated" | "configured" = "authenticated",
      backendProfileId = "builtin:anthropic",
    ) =>
      store.saveProviderMetadata({
        scope: {
          providerId: "claude",
          harnessId: "claude-agent-sdk",
          backendProfileId,
          modelId,
          executable: `/home/user/.local/share/claude/versions/${version}`,
          version,
          backendConfigurationRevision: 0,
          authState,
        },
        models: [],
        modelsUpdatedAt: "2026-10-25T10:00:00.000Z",
        modelsLastAttemptedAt: "2026-10-25T10:00:00.000Z",
        modelsProvenance: "provider",
        modelsStale: false,
        rateLimits: [],
        rateLimitsUpdatedAt: null,
        rateLimitsLastAttemptedAt: null,
        rateLimitsProvenance: null,
        rateLimitsStale: false,
      });
    saved("provider-catalog", "2.1.0");
    saved("provider-catalog", "2.1.0", "unauthenticated");
    saved("sonnet", "2.1.0");
    saved("k3", "2.1.0", "configured", "builtin:kimi-code");
    saved("provider-catalog", "2.1.1");
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.loadProviderMetadata().map(({ scope }) =>
      `${scope.backendProfileId} ${scope.modelId} ${scope.version} ${scope.authState}`).sort()).toEqual([
      "builtin:anthropic provider-catalog 2.1.1 authenticated",
      "builtin:anthropic sonnet 2.1.0 authenticated",
      "builtin:kimi-code k3 2.1.0 configured",
    ]);
    reopened.close();
  });
});
