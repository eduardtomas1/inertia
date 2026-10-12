import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { recordedCommandExitCode } from "../../src/server/persistence/command-exit-code";
import { lastTurnCommands } from "../../src/server/persistence/turn-context-facts";
import type { ProviderId } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commandsFor(providerId: ProviderId, detail: string, status: "completed" | "failed") {
  const root = await mkdtemp(join(tmpdir(), "inertia-turn-context-facts-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace);
  try {
    const project = store.createProject("Billing", workspace);
    const conversation = store.createConversation(project.id, "Release", {
      activate: false,
      modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }),
    });
    const { turn } = store.beginAgentTurn({
      id: randomUUID(),
      conversationId: conversation.id,
      runId: randomUUID(),
      content: "Release it.",
      activateConversation: false,
      providerId,
      harnessId: conversation.modelSelection.harnessId,
      backendProfileId: conversation.modelSelection.backendProfileId,
      model: conversation.modelSelection.modelId,
      modelAlias: null,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      usageAtStart: null,
      configurationRevision: conversation.modelSelection.backendConfigurationRevision,
      association: "authoritative",
    });
    store.addActivity({
      conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "command",
      title: "Bash", detail, status,
    });
    const database = new Database(databasePath, { readonly: true });
    try {
      return lastTurnCommands(database, turn.id);
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }
}

describe("turn command outcomes", () => {
  it.each([
    ["codex", "Command:\n./release.sh\n\nOutput:\nbuilding\nExit code: 0\nupload failed: 403", "failed", "./release.sh (failed)"],
    ["claude", "Command:\n./release.sh\n\nError:\nbuilding\nExit code: 0", "failed", "./release.sh (failed)"],
    ["claude", "Command:\n./release.sh\n\nOutput:\nExit code: 7", "completed", "./release.sh (ok)"],
    ["claude", "Command:\n./release.sh\n\nError:\nExit code 1\nupload failed: 403", "failed", "./release.sh (exit 1)"],
  ] as const)("takes a %s exit code only from the adapter's prefix line", async (providerId, detail, status, line) => {
    expect(await commandsFor(providerId, detail, status)).toEqual([line]);
  });

  it("never reads an exit code from output or from another provider", () => {
    expect(recordedCommandExitCode("claude", "failed", "Error:\nExit code: 3")).toBe(3);
    expect(recordedCommandExitCode("claude", "failed", "Command:\nx\n\nOutput:\nExit code 0\n\nError:\nboom")).toBeNull();
    expect(recordedCommandExitCode("claude", "completed", "Command:\nx\n\nError:\nExit code 1")).toBeNull();
    expect(recordedCommandExitCode("codex", "failed", "Command:\nx\n\nError:\nExit code 1")).toBeNull();
    expect(recordedCommandExitCode("claude", "failed", null)).toBeNull();
  });
});
