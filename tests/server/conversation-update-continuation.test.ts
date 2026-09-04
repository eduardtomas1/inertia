import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("conversation update continuation ownership", () => {
  it("does not reuse a latest-turn identity from another provider session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-conversation-update-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    mkdirSync(workspace);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    stores.push(store);
    const project = store.createProject("Continuation", workspace);
    const selection = modelSelectionSchema.parse(nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      reasoningEffort: "high",
    }));
    const route = resolveNativeModelRoute(selection);
    const conversation = store.createConversation(project.id, "Exact session", {
      modelSelection: selection,
    });
    store.updateConversation(conversation.id, {
      providerSessionId: "current-provider-session",
      continuationIdentity: route.continuationIdentity,
    });
    vi.spyOn(store, "latestAgentTurnForConversation").mockReturnValue({
      providerSessionAfter: "stale-provider-session",
      continuationIdentity: route.continuationIdentity,
      modelSelection: selection,
    } as never);

    const dependencies = {
      store,
      providers: {
        resolveModelRoute: vi.fn(() => route),
      },
      backendProfileController: {
        isExternalSelection: vi.fn(() => false),
        validateSelection: vi.fn(() => selection),
        supportsNativeFastModeControl: vi.fn(() => false),
      },
    } as unknown as ConversationCommandDependencies;
    const command: Extract<ClientCommand, { type: "conversation.update" }> = {
      type: "conversation.update",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        conversationId: conversation.id,
        modelSelection: selection,
      },
    };

    await expect(createConversationCommandHandler(dependencies)(
      {} as never,
      command,
    )).resolves.toBe("mutation");
    expect(store.conversation(conversation.id)).toMatchObject({
      providerSessionId: null,
      continuationIdentity: null,
    });
  });
});
