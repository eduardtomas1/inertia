import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type {
  AppSettings,
  Conversation,
  ConversationCompactAndSendResult,
  ProviderInfo,
  RuntimeMutationEvent,
  ServerEvent,
  ThreadUsageSnapshot,
} from "../../../shared/contracts";
import type { ContextCompaction, ContextCompactionTrigger } from "../../../shared/context-compaction";
import { compactOnReturnEligibility } from "../../../shared/compact-on-return";
import { CONVERSATION_COMPACTION_REQUEST_TIMEOUT_MS } from "../../../shared/runtime-command-timeouts";
import { importedResumeCwd } from "../../cli-import/resume-cwd";
import {
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../../shared/continuation-policy";
import {
  providerNativeBackendProfile,
  routeSupportsNativeFastModeIdentity,
  type ModelSelection,
} from "../../../shared/model-routing";
import type { RuntimeStore } from "../../database";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { ProviderManager } from "../../providers";
import { isUnreceiptedProviderRunRefusal } from "../../provider/contracts";
import { publicRuntimeError, RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { ConversationCompactionStates } from "../conversation-compaction-states";
import type { IsolatedRunController } from "../reviews/isolated-run-controller";
import type { TurnController } from "../turns/turn-controller";
import { resolveCustomAgentCall } from "../turns/custom-agent-call";
import { sessionInstructionDigest } from "../turns/turn-instruction-delivery";
import { isHeld, UPDATE_HOLD_MESSAGE } from "../update-hold";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import {
  createTurnInteractionCommandHandler,
  type CompactionHandoff,
  type TurnInteractionCommandDependencies,
} from "./turn-interaction-commands";

export const COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS =
  CONVERSATION_COMPACTION_REQUEST_TIMEOUT_MS - 30_000;

const COMPACTION_TIMED_OUT = "Compaction did not finish in time.";
const NOTHING_SENT = "Nothing was sent.";
const SIGN_IN_UNCONFIRMED = "Inertia could not confirm which Claude sign-in this chat uses.";
const CLEANUP_UNCONFIRMED =
  "Provider process cleanup could not be confirmed. This chat and checkout remain locked until the local runtime restarts safely.";
const LOCKED_FOR_COMPACTION =
  "Wait for the current provider or workspace operation to finish before compacting this chat.";
const BLOCKING_FAILURE_KINDS = new Set(["billing", "authentication", "rate-limited"]);

export interface ConversationCompactionCommandDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  turns: TurnController;
  isolatedRuns: IsolatedRunController<WebSocket>;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  enableProviders: boolean;
  lifetimeSignal?: AbortSignal;
  compactions?: ConversationCompactionStates;
  instructions?: Pick<TurnController, "compactionSessionInstruction" | "forgetPromptDelivery">;
  interaction?: TurnInteractionCommandDependencies;
  settings?(): Pick<AppSettings, "compactOnReturn">;
  refreshProviderAccount?(providerId: ProviderInfo["id"]): Promise<void>;
  providerInfo(): readonly ProviderInfo[];
  broadcast(event: RuntimeMutationEvent): void;
  broadcastConversationShell?(conversationId: string): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

interface PreparedCompaction {
  conversation: Conversation;
  selection: ModelSelection;
  route: ReturnType<ProviderManager["resolveModelRoute"]>;
  supportedFastMode: "priority" | "fast" | null;
}

interface CompactionRequest {
  instruction?: string;
  trigger: ContextCompactionTrigger;
  deadline?: AbortSignal;
}

interface CompactionProgress {
  locked: boolean;
  compacted: boolean;
}

interface CompactionReceipt {
  providerId: ContextCompaction["providerId"];
  conversationId: string;
  instructionForwarded: boolean;
  message: string;
  compaction: ContextCompaction;
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
  identity: { runId: string; turnId: string },
): Promise<boolean> {
  try {
    const stopped = await dependencies.providers.stopOwned(
      conversationId,
      identity,
    );
    return stopped === "settled";
  } catch {
    return false;
  }
}

async function withinDeadline<T>(operation: Promise<T>, deadline: AbortSignal | undefined): Promise<T> {
  if (!deadline) return await operation;
  if (deadline.aborted) throw new RuntimeRequestError(COMPACTION_TIMED_OUT);
  return await new Promise<T>((resolve, reject) => {
    const expire = (): void => reject(new RuntimeRequestError(COMPACTION_TIMED_OUT));
    deadline.addEventListener("abort", expire, { once: true });
    operation.then((value) => {
      deadline.removeEventListener("abort", expire);
      resolve(value);
    }, (error: unknown) => {
      deadline.removeEventListener("abort", expire);
      reject(error instanceof Error ? error : new RuntimeRequestError(COMPACTION_TIMED_OUT));
    });
  });
}

async function prepareCompaction(
  dependencies: ConversationCompactionCommandDependencies,
  conversationId: string,
  refuse: (conversation: Conversation, selection: ModelSelection) => void | Promise<void> = () => undefined,
  deadline?: AbortSignal,
): Promise<PreparedCompaction> {
  dependencies.lifetimeSignal?.throwIfAborted();
  if (!dependencies.enableProviders) {
    throw new RuntimeRequestError(
      "Provider operations are unavailable in recovery safety mode.",
    );
  }
  const conversation = dependencies.store.conversation(conversationId);
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
    throw new RuntimeRequestError(LOCKED_FOR_COMPACTION);
  }

  const providerSnapshots = dependencies.providerInfo();
  const selection = dependencies.backendProfileController
    .validateSelection(conversation.modelSelection);
  await refuse(conversation, selection);
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
  const readiness = await withinDeadline(dependencies.backendProfileController.readiness(
    selection,
    exactProvider,
  ), deadline);
  dependencies.lifetimeSignal?.throwIfAborted();
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
  const latestTurnOwnsProviderSession = latestTurn !== null
    && latestTurn.providerSessionAfter === conversation.providerSessionId;
  // Compaction mutates provider-owned hidden context. Never pair the shell's
  // session ID with compatibility evidence from a different terminal turn.
  const previousContinuationIdentity = latestTurn
    ? latestTurnOwnsProviderSession
      ? latestTurn.continuationIdentity
      : null
    : conversation.continuationIdentity ?? null;
  const previousContinuationModelId = previousContinuationIdentity
    ? selection.modelId === "provider-default"
      ? "provider-default"
      : latestTurn
        ? latestTurn.modelSelection.modelId
        : selection.modelId
    : null;
  const continuation = resolveContinuationDecision({
    previousIdentity: previousContinuationIdentity,
    nextIdentity: route.continuationIdentity,
    previousModelId: previousContinuationModelId,
    nextModelId: selection.modelId,
    hasProviderSession: true,
    hasTurns: latestTurn !== null,
    allowsModelSwitchWithinSession:
      officiallyAllowsModelSwitchWithinSession(route.compatibility),
  });
  if (continuation.action !== "resume-session") {
    throw new RuntimeRequestError(continuation.reason);
  }
  return { conversation, selection, route, supportedFastMode };
}

function publishCompactionState(
  dependencies: ConversationCompactionCommandDependencies,
  conversationId: string,
): void {
  try {
    dependencies.broadcastConversationShell?.(conversationId);
  } catch {
    return;
  }
}

async function compactUnderLock<T>(
  dependencies: ConversationCompactionCommandDependencies,
  prepared: PreparedCompaction,
  request: CompactionRequest,
  progress: CompactionProgress,
  completed: (receipt: CompactionReceipt) => Promise<T>,
): Promise<T> {
  const { conversation, selection, route, supportedFastMode } = prepared;
  if (!dependencies.providerTerminalResumes.acquire(conversation.id)) {
    throw new RuntimeRequestError(LOCKED_FOR_COMPACTION);
  }
  progress.locked = true;
  const tracked = dependencies.compactions?.begin(conversation.id, request.trigger) ?? false;
  if (tracked) publishCompactionState(dependencies, conversation.id);
  let releaseAuthority = true;
  const compactionRunId = randomUUID();
  // Compaction does not create a durable AgentTurn, but it still receives an
  // independently allocated exact turn identity for provider correlation.
  const compactionTurnId = randomUUID();
  // Request cleanup during quiescence; retain authority until this exact receipt joins below.
  let lifetimeStop: Promise<boolean> | undefined;
  const confirmCleanup = (): Promise<boolean> => lifetimeStop ?? confirmCompactionCleanup(
    dependencies, conversation.id, { runId: compactionRunId, turnId: compactionTurnId },
  );
  const stopForRuntimeShutdown = (): void => { lifetimeStop ??= confirmCleanup(); };
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
    const beforeTokens = dependencies.store.usageForConversation(conversation.id)?.usedTokens ?? null;
    let afterTokens: number | null = null;
    let usageObserved = false;
    let usageProjectionFailed = false;
    let result: Awaited<ReturnType<ProviderManager["compact"]>>;
    const sessionInstruction = dependencies.instructions?.compactionSessionInstruction(currentConversation, route);
    dependencies.lifetimeSignal?.throwIfAborted();
    if (request.deadline?.aborted) throw new RuntimeRequestError(COMPACTION_TIMED_OUT);
    try {
      dependencies.lifetimeSignal?.addEventListener("abort", stopForRuntimeShutdown, { once: true });
      request.deadline?.addEventListener("abort", stopForRuntimeShutdown, { once: true });
      result = await dependencies.providers.compact({
        providerId: route.providerId,
        harnessId: route.harnessId,
        backendProfile: route.backendProfile,
        backendCompatibility: route.compatibility,
        modelSelection: selection,
        continuationIdentity: route.continuationIdentity,
        conversationId: conversation.id,
        runId: compactionRunId,
        turnId: compactionTurnId,
        cwd: importedResumeCwd(dependencies.store, conversation.id, currentConversation.providerSessionId, dependencies.store.conversationPath(conversation.id)),
        prompt: "/compact",
        model: selection.modelId === "provider-default"
          ? undefined
          : selection.modelId,
        reasoningEffort: selection.reasoningEffort || undefined,
        interactionMode: currentConversation.interactionMode,
        access: currentConversation.accessMode,
        sessionId: currentConversation.providerSessionId!,
        ...(supportedFastMode ? { supportedFastMode } : {}),
        ...(sessionInstruction === undefined ? {} : { sessionInstruction }),
      }, request.instruction, {
        onUsage: (event) => {
          afterTokens = event.usage.usedTokens;
          usageObserved = true;
          try { projectUsage(dependencies, conversation.id, event.usage); }
          catch { usageProjectionFailed = true; }
        },
      });
    } catch (error) {
      if (
        !isUnreceiptedProviderRunRefusal(error, {
          conversationId: conversation.id,
          runId: compactionRunId,
          turnId: compactionTurnId,
        })
        && !await confirmCleanup()
      ) {
        releaseAuthority = false;
        throw new RuntimeRequestError(CLEANUP_UNCONFIRMED);
      }
      throw error;
    }
    if (
      (lifetimeStop || !result.cleanupConfirmed)
      && !await confirmCleanup()
    ) {
      releaseAuthority = false;
      throw new RuntimeRequestError(CLEANUP_UNCONFIRMED);
    }
    dependencies.lifetimeSignal?.throwIfAborted();
    if (result.status !== "completed") {
      throw new RuntimeRequestError(request.deadline?.aborted ? COMPACTION_TIMED_OUT : result.message);
    }
    progress.compacted = true;
    dependencies.instructions?.forgetPromptDelivery(conversation.id);
    if (!usageObserved) {
      try { invalidateStaleContextUsage(dependencies, conversation.id); }
      catch { usageProjectionFailed = true; }
    }
    // Provider completion is irreversible; local reporting must not invite a retry.
    let resultMessage = result.message;
    if (usageProjectionFailed) resultMessage += " Usage could not be refreshed.";
    const compaction: ContextCompaction = {
      providerId: result.providerId,
      beforeTokens,
      afterTokens,
      instructionForwarded: result.instructionForwarded,
      trigger: request.trigger,
      sessionInstructionDigest: sessionInstruction === undefined ? null : sessionInstructionDigest(sessionInstruction),
    };
    try {
      const message = dependencies.store.createMessage(
        conversation.id,
        request.instruction ? `/compact ${request.instruction}` : "/compact",
        "system", [], null, undefined,
        { compaction },
      );
      try { dependencies.broadcast({ type: "conversation.message.persisted", message }); }
      catch { resultMessage += " The receipt was saved, but the timeline could not refresh. Reload this chat to view it."; }
    } catch { resultMessage += " The compaction receipt could not be saved."; }
    return await completed({
      providerId: result.providerId,
      conversationId: result.conversationId,
      instructionForwarded: result.instructionForwarded,
      message: resultMessage,
      compaction,
    });
  } finally {
    dependencies.lifetimeSignal?.removeEventListener("abort", stopForRuntimeShutdown);
    request.deadline?.removeEventListener("abort", stopForRuntimeShutdown);
    if (releaseAuthority) {
      dependencies.providerTerminalResumes.release(conversation.id);
    }
    if (tracked) {
      dependencies.compactions?.end(conversation.id);
      publishCompactionState(dependencies, conversation.id);
    }
  }
}

class SignInUnconfirmedError extends RuntimeRequestError {}

function refuseUnlessCompactableOnReturn(
  dependencies: ConversationCompactionCommandDependencies,
  conversation: Conversation,
  selection: ModelSelection,
  calledAgent?: { agentId: string },
): ((deadline: AbortSignal) => Promise<void>) | null {
  if (conversation.archivedAt !== null) {
    throw new RuntimeRequestError("Unarchive this chat before sending to it.");
  }
  if (calledAgent) {
    resolveCustomAgentCall({ calledAgent, store: dependencies.store, providerId: conversation.providerId });
  }
  if (dependencies.store.watcherLinks.findByWatcher(conversation.id)) {
    throw new RuntimeRequestError("Watcher chats are not compacted on return.");
  }
  const latestTurn = dependencies.store.conversationShell(conversation.id)?.latestTurn ?? null;
  if (
    latestTurn?.usageLimited === true
    || (latestTurn?.status === "failed"
      && latestTurn.failureKind !== undefined
      && BLOCKING_FAILURE_KINDS.has(latestTurn.failureKind))
  ) {
    throw new RuntimeRequestError(
      "The last turn stopped on a usage limit, billing, sign-in or rate-limit problem. Resolve it before compacting this chat.",
    );
  }
  if (dependencies.settings?.().compactOnReturn === "never") {
    throw new RuntimeRequestError("Compacting on return is set to Never in Settings → Chats.");
  }
  const profile = dependencies.backendProfileController
    .profiles(dependencies.providerInfo())
    .find(({ id }) => id === selection.backendProfileId);
  const eligibility = (): ReturnType<typeof compactOnReturnEligibility> => compactOnReturnEligibility({
    harnessId: selection.harnessId,
    preset: profile?.preset ?? null,
    protocol: profile?.protocol ?? "",
    accountKind: profile
      ? dependencies.providerInfo().find(({ id }) => id === profile.providerId)?.accountKind ?? null
      : null,
    ...(profile ? { routeKind: profile.routeKind } : {}),
    promptCacheTtl: profile?.promptCacheTtl ?? null,
  });
  const refuseIneligible = (): void => {
    const decision = eligibility();
    if (!decision.eligible) {
      throw new RuntimeRequestError(
        decision.reason ?? "Compact on return is not available for this chat.",
      );
    }
  };
  refuseIneligible();
  const refreshProviderAccount = dependencies.refreshProviderAccount;
  if (profile?.preset !== "native" || !refreshProviderAccount) return null;
  return async (deadline) => {
    try {
      await withinDeadline(refreshProviderAccount(profile.providerId), deadline);
    } catch (error) {
      if (deadline.aborted) throw error;
      throw new SignInUnconfirmedError(SIGN_IN_UNCONFIRMED);
    }
    refuseIneligible();
  };
}

function failedCompactionMessage(error: unknown): string {
  const message = publicRuntimeError(error).trim();
  return `${message}${/[.!?]$/u.test(message) ? "" : "."} ${NOTHING_SENT}`;
}

async function claimAttachments(
  interaction: TurnInteractionCommandDependencies,
  command: Extract<Parameters<RuntimeCommandHandler>[1], { type: "conversation.compact-and-send" }>,
  deadline: AbortSignal,
): Promise<CompactionHandoff["attachments"]> {
  if (command.payload.attachments.length === 0) return [];
  if (!interaction.attachmentResolver) {
    throw new RuntimeRequestError(
      "The selected attachment is no longer available or could not be verified.",
    );
  }
  return await interaction.attachmentResolver.resolvePayloads(
    command.payload.attachments,
    command.requestId,
    deadline,
  );
}

async function sendAfterCompaction(
  dependencies: ConversationCompactionCommandDependencies,
  interaction: TurnInteractionCommandDependencies,
  command: Extract<Parameters<RuntimeCommandHandler>[1], { type: "conversation.compact-and-send" }>,
  receipt: CompactionReceipt,
  handoff: CompactionHandoff,
): Promise<ConversationCompactAndSendResult> {
  const { reason: _reason, ...payload } = command.payload;
  let accepted: Extract<ServerEvent, { type: "request.result" }>["result"] | null = null;
  const handler = createTurnInteractionCommandHandler({
    ...interaction,
    compactionHandoff: handoff,
    send: (_socket, event) => {
      if (event.type === "request.result") accepted = event.result;
    },
  });
  await handler(null as unknown as WebSocket, {
    type: "message.send",
    requestId: command.requestId,
    payload,
  });
  const result = accepted as Extract<ServerEvent, { type: "request.result" }>["result"] | null;
  if (!result || result.kind !== "message.accepted") {
    throw new RuntimeRequestError(
      "The chat was compacted, but the message could not be sent. Send it again.",
    );
  }
  dependencies.lifetimeSignal?.throwIfAborted();
  return {
    kind: "conversation.compact-and-send",
    outcome: "sent",
    conversationId: result.conversationId,
    turnId: result.turnId,
    userMessageId: result.userMessageId,
    disposition: result.disposition,
    compaction: receipt.compaction,
  };
}

export function createConversationCompactionCommandHandler(
  dependencies: ConversationCompactionCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "conversation.compact",
    "conversation.compact-and-send",
  ], async (socket, command) => {
    if (command.type === "conversation.compact") {
      const prepared = await prepareCompaction(dependencies, command.payload.conversationId);
      return await compactUnderLock(dependencies, prepared, {
        ...(command.payload.instruction ? { instruction: command.payload.instruction } : {}),
        trigger: "manual",
      }, { locked: false, compacted: false }, async (receipt) => {
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.compacted",
            conversationId: receipt.conversationId,
            providerId: receipt.providerId,
            instructionForwarded: receipt.instructionForwarded,
            message: receipt.message,
          },
        });
        return "handled" as const;
      });
    }
    if (command.type !== "conversation.compact-and-send") return "not-handled";
    if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    const interaction = dependencies.interaction;
    if (!interaction) {
      throw new RuntimeRequestError("Compact on return is unavailable in this runtime.");
    }
    const progress: CompactionProgress = { locked: false, compacted: false };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS);
    timer.unref?.();
    const handoff: CompactionHandoff = {
      conversationId: command.payload.conversationId,
      attachments: [],
      attachmentsTaken: false,
    };
    let result: ConversationCompactAndSendResult;
    try {
      const prepared = await prepareCompaction(
        dependencies,
        command.payload.conversationId,
        async (conversation, selection) => {
          const recheckSignIn = refuseUnlessCompactableOnReturn(
            dependencies,
            conversation,
            selection,
            command.payload.context?.calledAgent,
          );
          handoff.attachments = await claimAttachments(interaction, command, deadline.signal);
          await recheckSignIn?.(deadline.signal);
        },
        deadline.signal,
      );
      result = await compactUnderLock(dependencies, prepared, {
        trigger: "on-return",
        deadline: deadline.signal,
      }, progress, async (receipt) => {
        clearTimeout(timer);
        return await sendAfterCompaction(dependencies, interaction, command, receipt, handoff);
      });
    } catch (error) {
      if (
        progress.compacted
        || dependencies.lifetimeSignal?.aborted
        || (!progress.locked && !deadline.signal.aborted && !(error instanceof SignInUnconfirmedError))
      ) throw error;
      result = {
        kind: "conversation.compact-and-send",
        conversationId: command.payload.conversationId,
        outcome: "compaction-failed",
        message: failedCompactionMessage(error),
      };
    } finally {
      clearTimeout(timer);
      if (!handoff.attachmentsTaken && handoff.attachments.length > 0) {
        await interaction.attachmentResolver?.relinquishAll(handoff.attachments.map(({ attachment }) => attachment.id));
      }
    }
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result,
    });
    return "handled";
  });
}
