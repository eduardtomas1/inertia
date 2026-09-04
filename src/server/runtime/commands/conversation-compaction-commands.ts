import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type {
  Conversation,
  ProviderInfo,
  RuntimeMutationEvent,
  ServerEvent,
  ThreadUsageSnapshot,
} from "../../../shared/contracts";
import {
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../../shared/continuation-policy";
import {
  providerNativeBackendProfile,
  routeSupportsNativeFastModeIdentity,
} from "../../../shared/model-routing";
import { GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON } from
  "../../../shared/provider";
import type { RuntimeStore } from "../../database";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { ProviderManager } from "../../providers";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { IsolatedRunController } from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface ConversationCompactionCommandDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  enableProviders: boolean;
  providerInfo(): readonly ProviderInfo[];
  broadcast(event: RuntimeMutationEvent): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

function sameCompactionConfiguration(
  left: Conversation,
  right: Conversation,
): boolean {
  return left.providerId === right.providerId
    && left.providerSessionId === right.providerSessionId
    && left.interactionMode === right.interactionMode
    && left.accessMode === right.accessMode
    && JSON.stringify(left.modelSelection) === JSON.stringify(right.modelSelection)
    && JSON.stringify(left.continuationIdentity)
      === JSON.stringify(right.continuationIdentity);
}

function projectUsage(
  dependencies: ConversationCompactionCommandDependencies,
  conversationId: string,
  usage: Omit<
    ThreadUsageSnapshot,
    "conversationId" | "turnId" | "updatedAt"
  >,
): void {
  const current = dependencies.store.usageForConversation(conversationId);
  const snapshot = dependencies.store.upsertUsage({
    conversationId,
    turnId: current?.turnId ?? null,
    ...usage,
  });
  dependencies.broadcast({ type: "agent.usage", usage: snapshot });
}

function invalidateStaleContextUsage(
  dependencies: ConversationCompactionCommandDependencies,
  conversationId: string,
): void {
  const current = dependencies.store.usageForConversation(conversationId);
  if (!current || current.usedTokens === null) return;
  projectUsage(dependencies, conversationId, {
    usedTokens: null,
    totalProcessedTokens: current.totalProcessedTokens,
    totalProcessedScope: current.totalProcessedScope,
    maxTokens: current.maxTokens,
    inputTokens: current.inputTokens,
    cachedInputTokens: current.cachedInputTokens,
    cacheWriteInputTokens: current.cacheWriteInputTokens,
    outputTokens: current.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens,
    compactsAutomatically: current.compactsAutomatically,
  });
}

async function confirmCompactionCleanup(
  dependencies: ConversationCompactionCommandDependencies,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  try {
    const stopped = await dependencies.providers.stopOwned(
      conversationId,
      { runId, turnId: null },
    );
    return stopped === "settled"
      || (stopped === "missing"
        && !dependencies.providers.isRunning(conversationId));
  } catch {
    return false;
  }
}

export function createConversationCompactionCommandHandler(
  dependencies: ConversationCompactionCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "conversation.compact",
  ], async (socket, command) => {
    if (command.type !== "conversation.compact") return "not-handled";
    if (!dependencies.enableProviders) {
      throw new RuntimeRequestError(
        "Provider operations are unavailable in recovery safety mode.",
      );
    }
    const conversation = dependencies.store.conversation(
      command.payload.conversationId,
    );
    if (conversation.providerId === "gemini") {
      throw new RuntimeRequestError(
        GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON,
      );
    }
    if (!conversation.providerSessionId) {
      throw new RuntimeRequestError(
        "This chat does not have a provider session to compact yet.",
      );
    }
    try {
      dependencies.store.assertDuoComparisonTurnAllowed(conversation.id);
    } catch (error) {
      throw new RuntimeRequestError(
        error instanceof Error
          ? error.message
          : "That judge chat is reserved for a Duo comparison.",
      );
    }
    if (
      dependencies.providerTerminalResumes.isActive(conversation.id)
      || dependencies.turns.isActive(conversation.id)
      || dependencies.isolatedRuns.has(conversation.id)
    ) {
      throw new RuntimeRequestError(
        "Wait for the current provider or workspace operation to finish before compacting this chat.",
      );
    }

    const providerSnapshots = dependencies.providerInfo();
    const initialSelection = dependencies.backendProfileController
      .validateSelection(conversation.modelSelection);
    const selection = initialSelection;
    const route = dependencies.providers.resolveModelRoute(selection);
    const exactProvider = providerSnapshots.find(
      ({ id }) => id === route.providerId,
    );
    const exactModel = selection.modelId === "provider-default"
      ? exactProvider?.models.find(({ isDefault }) => isDefault)
        ?? exactProvider?.models[0]
      : exactProvider?.models.find(({ id }) => id === selection.modelId);
    const expectedFastMode = route.providerId === "codex"
      ? "priority"
      : route.providerId === "claude"
        ? "fast"
        : null;
    const supportedFastMode = exactProvider?.id === route.providerId
      && route.backendProfile.id === providerNativeBackendProfile(route.providerId).id
      && routeSupportsNativeFastModeIdentity(selection)
      && exactModel?.fastMode?.providerValue === expectedFastMode
      ? expectedFastMode
      : null;
    const readiness = await dependencies.backendProfileController.readiness(
      selection,
      exactProvider,
    );
    if (readiness && !readiness.ready) {
      throw new RuntimeRequestError(
        readiness.message ?? "The selected model backend is unavailable.",
      );
    }
    if (!readiness && !exactProvider?.canRun) {
      throw new RuntimeRequestError(
        exactProvider?.statusMessage
          ?? "This agent is not ready. Open Settings to finish setup.",
      );
    }

    const latestTurn = dependencies.store.latestAgentTurnForConversation(
      conversation.id,
    );
    const continuation = resolveContinuationDecision({
      previousIdentity: latestTurn?.continuationIdentity
        ?? conversation.continuationIdentity
        ?? null,
      nextIdentity: route.continuationIdentity,
      previousModelId: selection.modelId === "provider-default"
        ? "provider-default"
        : latestTurn?.modelSelection.modelId
          ?? (conversation.continuationIdentity
            ? selection.modelId
            : null),
      nextModelId: selection.modelId,
      hasProviderSession: true,
      hasTurns: latestTurn !== null,
      allowsModelSwitchWithinSession:
        officiallyAllowsModelSwitchWithinSession(route.compatibility),
    });
    if (continuation.action !== "resume-session") {
      throw new RuntimeRequestError(continuation.reason);
    }

    if (!dependencies.providerTerminalResumes.acquire(conversation.id)) {
      throw new RuntimeRequestError(
        "Wait for the current provider or workspace operation to finish before compacting this chat.",
      );
    }
    let releaseAuthority = true;
    const compactionRunId = randomUUID();
    try {
      if (
        dependencies.turns.isActive(conversation.id)
        || dependencies.isolatedRuns.has(conversation.id)
      ) {
        throw new RuntimeRequestError(
          "Wait for the current provider operation to finish before compacting this chat.",
        );
      }
      const currentConversation = dependencies.store.conversation(
        conversation.id,
      );
      if (!sameCompactionConfiguration(conversation, currentConversation)) {
        throw new RuntimeRequestError(
          "The chat configuration changed while compaction was starting. Try again with the current provider settings.",
        );
      }
      let usageObserved = false;
      let result: Awaited<ReturnType<ProviderManager["compact"]>>;
      try {
        result = await dependencies.providers.compact({
          providerId: route.providerId,
          harnessId: route.harnessId,
          backendProfile: route.backendProfile,
          backendCompatibility: route.compatibility,
          modelSelection: selection,
          continuationIdentity: route.continuationIdentity,
          conversationId: conversation.id,
          runId: compactionRunId,
          cwd: dependencies.store.conversationPath(conversation.id),
          prompt: "/compact",
          model: selection.modelId === "provider-default"
            ? undefined
            : selection.modelId,
          reasoningEffort: selection.reasoningEffort || undefined,
          interactionMode: currentConversation.interactionMode,
          access: currentConversation.accessMode,
          sessionId: currentConversation.providerSessionId!,
          ...(supportedFastMode ? { supportedFastMode } : {}),
        }, command.payload.instruction, {
          onUsage: (event) => {
            projectUsage(dependencies, conversation.id, event.usage);
            usageObserved = true;
          },
        });
      } catch (error) {
        if (!await confirmCompactionCleanup(
          dependencies,
          conversation.id,
          compactionRunId,
        )) {
          releaseAuthority = false;
          throw new RuntimeRequestError(
            "Provider process cleanup could not be confirmed. This chat and checkout remain locked until the local runtime restarts safely.",
          );
        }
        throw error;
      }
      if (
        !result.cleanupConfirmed
        && !await confirmCompactionCleanup(
          dependencies,
          conversation.id,
          compactionRunId,
        )
      ) {
        releaseAuthority = false;
        throw new RuntimeRequestError(
          "Provider process cleanup could not be confirmed. This chat and checkout remain locked until the local runtime restarts safely.",
        );
      }
      if (result.status !== "completed") {
        throw new RuntimeRequestError(result.message);
      }
      if (!usageObserved) {
        invalidateStaleContextUsage(dependencies, conversation.id);
      }
      dependencies.send(socket, {
        type: "request.result",
        requestId: command.requestId,
        result: {
          kind: "conversation.compacted",
          conversationId: result.conversationId,
          providerId: result.providerId,
          instructionForwarded: result.instructionForwarded,
          message: result.message,
        },
      });
      return "handled";
    } finally {
      if (releaseAuthority) {
        dependencies.providerTerminalResumes.release(conversation.id);
      }
    }
  });
}
