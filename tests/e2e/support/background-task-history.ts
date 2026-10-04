import { randomUUID } from "node:crypto";

import type { RuntimeStore } from "../../../src/server/database";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../../src/shared/model-routing";

export function seedLongChat(
  store: RuntimeStore,
  projectId: string,
  ago: (milliseconds: number) => string,
): { conversationId: string; title: string } {
  const title = "Long delegated history";
  const conversation = store.createConversation(projectId, title, { providerId: "claude" });
  const selection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-sonnet-4-5" });
  const continuationIdentity = continuationIdentityForSelection(selection, "native:claude:e2e");
  const turnCount = 46;
  const helpers: Record<number, Array<{ name: string; status: "completed" | "failed" }>> = {
    0: Array.from({ length: 8 }, (_, index) => ({ name: `Archived reader ${index}`, status: index === 0 ? "failed" : "completed" })),
    1: Array.from({ length: 8 }, (_, index) => ({ name: `Archived writer ${index}`, status: "completed" })),
    2: Array.from({ length: 8 }, (_, index) => ({ name: `Archived checker ${index}`, status: index === 7 ? "failed" : "completed" })),
    44: [{ name: "Target reader", status: "completed" }, { name: "Target writer", status: "completed" }],
    45: Array.from({ length: 12 }, (_, index) => ({ name: `Newest helper ${index}`, status: "completed" })),
  };
  for (let index = 0; index < turnCount; index += 1) {
    const requestedAt = ago((turnCount - index) * 600_000);
    const { turn } = store.beginAgentTurn({
      conversationId: conversation.id,
      runId: `background-tasks-long-${randomUUID()}`,
      content: `Step ${index + 1} of the long delegated history.`,
      providerId: "claude",
      modelSelection: selection,
      continuationIdentity,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: "claude-e2e-long-session",
      configurationRevision: selection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: requestedAt, completedAt: requestedAt, updatedAt: requestedAt });
    (helpers[index] ?? []).forEach(({ name, status }, position) => {
      store.upsertSubagentTrace({
        parentProviderAgentId: null,
        parentProviderToolUseId: null,
        providerToolUseId: null,
        providerRole: null,
        providerStatus: null,
        description: null,
        progress: null,
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        providerId: "claude",
        providerTaskId: `task-long-${index}-${position}`,
        providerAgentId: null,
        providerName: name,
        status,
        isLive: false,
        result: status === "failed" ? "Stopped early." : "Done.",
        sequence: position + 1,
        updatedAt: ago((turnCount - index) * 600_000 - (position + 1) * 1_000),
      });
    });
  }
  return { conversationId: conversation.id, title };
}
