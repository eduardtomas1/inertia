import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";

const directories: string[] = [];

async function createStore(): Promise<{
  databasePath: string;
  workspacePath: string;
  store: RuntimeStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-fast-store-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "runtime.sqlite");
  return {
    databasePath,
    workspacePath,
    store: new RuntimeStore(databasePath, workspacePath),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Fast mode persistence", () => {
  it("requires turn speed provenance to match its model selection", async () => {
    const { store, workspacePath } = await createStore();
    const project = store.createProject("Fast provenance", workspacePath);
    const conversation = store.createConversation(project.id, "Fast turn");
    const userMessage = store.createMessage(conversation.id, "Run in Fast mode.");
    const fastSelection = nativeModelSelection({
      providerId: "claude",
      modelId: "claude-opus",
      providerOptions: { fastMode: "fast" },
    });

    expect(() => store.createAgentTurn({
      conversationId: conversation.id,
      runId: "run-mismatched-performance-identity",
      userMessageId: userMessage.id,
      providerId: "claude",
      modelSelection: fastSelection,
      continuationIdentity: continuationIdentityForSelection(
        nativeModelSelection({ providerId: "claude", modelId: "claude-opus" }),
      ),
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "full",
      configurationRevision: 0,
      association: "authoritative",
    })).toThrow(/continuation identity does not match/iu);
    store.close();
  });

  it("preserves Fast selection and continuation identity across restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.createProject("Fast restart", workspacePath);
    const selection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-fast",
      reasoningEffort: "high",
      providerOptions: { fastMode: "priority" },
    });
    const conversation = store.createConversation(project.id, "Fast route", {
      modelSelection: selection,
    });
    const updated = store.updateConversation(conversation.id, {
      providerSessionId: "fast-session",
    });
    expect(updated.continuationIdentity).toMatchObject({
      performanceModeIdentity: "fast:priority",
    });
    expect(store.updateConversation(conversation.id, {
      reasoningEffort: "high",
    }).modelSelection.providerOptions).toEqual({ fastMode: "priority" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.conversation(conversation.id)).toMatchObject({
      modelSelection: { providerOptions: { fastMode: "priority" } },
      continuationIdentity: { performanceModeIdentity: "fast:priority" },
    });
    reopened.close();
  });

  it("preserves both pending speed transitions across restart", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const project = store.createProject("Pending speeds", workspacePath);
    const standardSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-speed",
    });
    const fastSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-speed",
      providerOptions: { fastMode: "priority" },
    });
    const toFast = store.createConversation(project.id, "Pending Fast", {
      modelSelection: standardSelection,
    });
    store.updateConversation(toFast.id, { providerSessionId: "standard-session" });
    store.updateConversation(toFast.id, { modelSelection: fastSelection });
    const toStandard = store.createConversation(project.id, "Pending Standard", {
      modelSelection: fastSelection,
    });
    store.updateConversation(toStandard.id, { providerSessionId: "fast-session" });
    store.updateConversation(toStandard.id, { modelSelection: standardSelection });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    const pendingFast = reopened.conversation(toFast.id);
    expect(pendingFast).toMatchObject({
      modelSelection: { providerOptions: { fastMode: "priority" } },
    });
    expect(pendingFast.continuationIdentity?.performanceModeIdentity ?? null)
      .toBeNull();
    expect(reopened.conversation(toStandard.id)).toMatchObject({
      modelSelection: { providerOptions: {} },
      continuationIdentity: { performanceModeIdentity: "fast:priority" },
    });
    reopened.close();
  });
});
