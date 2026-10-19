import type {
  AgentTurn,
  ClientCommand,
  Conversation,
} from "../../shared/contracts";
import {
  continuationSelectionMoved,
  officiallyAllowsFastModeSwitchWithinSession,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../shared/continuation-policy";
import {
  providerNativeModelSelection,
  type ModelSelection,
} from "../../shared/model-routing";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import { RuntimeRequestError } from "../runtime-errors";
import type { BackendProfileController } from "./backends/backend-profile-controller";

export type ConversationUpdatePayload = Extract<
  ClientCommand,
  { type: "conversation.update" }
>["payload"];

/**
 * Who asked for the change. A user's model, reasoning effort or Fast mode
 * change in an Auto chat is an override, so it returns the chat to manual
 * unless the payload names a mode itself. Auto routing never changes the
 * mode: a chat that left Auto keeps the user's choice.
 */
export type ConversationUpdateOrigin = "user" | "auto-routing";

export interface ConversationUpdateDependencies {
  store: Pick<
    RuntimeStore,
    | "conversation"
    | "latestAgentTurnForConversation"
    | "assertDuoComparisonTurnAllowed"
    | "hasActiveWorkspaceRunForConversation"
    | "updateConversation"
  >;
  providers: Pick<ProviderManager, "resolveModelRoute">;
  backendProfileController: Pick<
    BackendProfileController,
    "isExternalSelection" | "validateSelection" | "supportsNativeFastModeControl"
  >;
}

function requestedConversationModelSelection(
  current: Conversation,
  update: ConversationUpdatePayload,
): ModelSelection {
  if (update.modelSelection) return update.modelSelection;
  if (
    update.providerId === undefined
    && update.model === undefined
    && update.reasoningEffort === undefined
  ) {
    return current.modelSelection;
  }

  const providerId = update.providerId ?? current.providerId;
  const providerChanged = providerId !== current.providerId;
  return providerNativeModelSelection({
    providerId,
    modelId: update.model ?? (
      providerChanged ? "provider-default" : current.modelSelection.modelId
    ),
    alias: update.model ?? (
      providerChanged ? null : current.modelSelection.alias
    ),
    reasoningEffort: update.reasoningEffort ?? (
      providerChanged ? null : current.modelSelection.reasoningEffort
    ),
    providerOptions: providerChanged
      ? {}
      : current.modelSelection.providerOptions,
  });
}

/**
 * The one validated path for changing a chat's route and run configuration.
 * Both the renderer's `conversation.update` command and Auto routing use it,
 * so an automatic change performs the same canonicalisation, provider
 * session reset and continuation decision as a manual one.
 */
export class ConversationUpdateService {
  constructor(private readonly dependencies: ConversationUpdateDependencies) {}

  private selectionMovedSinceTurn(current: Conversation, turn: AgentTurn): boolean {
    try {
      return continuationSelectionMoved(
        turn.continuationIdentity,
        turn.modelSelection.modelId,
        this.dependencies.providers.resolveModelRoute(current.modelSelection).continuationIdentity,
        current.modelSelection.modelId,
      );
    } catch {
      return false;
    }
  }

  update(
    payload: ConversationUpdatePayload,
    origin: ConversationUpdateOrigin = "user",
  ): Conversation {
    const { dependencies } = this;
    const {
      conversationId,
      pinned,
      snoozedUntil,
      ...update
    } = payload;
    const current = dependencies.store.conversation(conversationId);
    if (
      dependencies.backendProfileController.isExternalSelection(
        current.modelSelection,
      )
      && update.modelSelection === undefined
      && (
        update.model !== undefined
        || update.reasoningEffort !== undefined
      )
    ) {
      throw new RuntimeRequestError(
        "External backend model and reasoning changes require a verified model selection.",
      );
    }
    const changesSelection = (
      update.providerId !== undefined
      || update.modelSelection !== undefined
      || update.model !== undefined
      || update.reasoningEffort !== undefined
    );
    let canonicalSelection: ModelSelection | null = null;
    let canonicalProviderId: Conversation["providerId"] | null = null;
    let resetProviderSession = false;
    let restoredProviderSession: Pick<Conversation, "providerSessionId" | "continuationIdentity"> | null = null;
    if (changesSelection) {
      const selection = dependencies.backendProfileController
        .validateSelection(
          requestedConversationModelSelection(
            current,
            payload,
          ),
        );
      const route = dependencies.providers.resolveModelRoute(selection);
      if (
        update.providerId !== undefined
        && update.providerId !== route.providerId
      ) {
        throw new RuntimeRequestError(
          "The selected provider does not match the verified model route.",
        );
      }
      canonicalSelection = selection;
      canonicalProviderId = route.providerId;
      const latestTurn = dependencies.store
        .latestAgentTurnForConversation(conversationId);
      const savedSessionId = current.providerSessionId
        ?? (latestTurn && isAgentTurnTerminalStatus(latestTurn.status)
          && this.selectionMovedSinceTurn(current, latestTurn)
          ? latestTurn.providerSessionAfter
          : null);
      const latestTurnMatchesSession = latestTurn !== null
        && savedSessionId !== null
        && latestTurn.providerSessionAfter === savedSessionId;
      const decision = resolveContinuationDecision({
        previousProviderId: latestTurn?.providerId ?? current.providerId,
        previousIdentity: latestTurn
          ? latestTurnMatchesSession
            ? latestTurn.continuationIdentity
            : null
          : current.continuationIdentity ?? null,
        nextIdentity: route.continuationIdentity,
        previousModelId: latestTurn
          ? latestTurnMatchesSession
            ? latestTurn.modelSelection.modelId
            : null
          : current.continuationIdentity
          ? current.modelSelection.modelId
          : null,
        nextModelId: selection.modelId,
        hasProviderSession: savedSessionId !== null,
        hasTurns: latestTurn !== null,
        allowsModelSwitchWithinSession:
          officiallyAllowsModelSwitchWithinSession(route.compatibility),
        allowsPerformanceModeSwitchWithinSession:
          officiallyAllowsFastModeSwitchWithinSession(route.compatibility)
          && dependencies.backendProfileController
            .supportsNativeFastModeControl(selection),
      });
      resetProviderSession = decision.action === "start-session"
        && (current.providerSessionId !== null || latestTurn !== null);
      restoredProviderSession = decision.action === "resume-session"
        && current.providerSessionId === null
        && latestTurnMatchesSession
        ? {
            providerSessionId: savedSessionId,
            continuationIdentity: latestTurn.continuationIdentity,
          }
        : null;
    }
    const routingMode = update.routingMode
      ?? (origin === "user" && changesSelection && current.routingMode === "auto" ? "manual" : undefined);
    const changesAgentConfiguration = (
      changesSelection
      || update.interactionMode !== undefined
      || update.accessMode !== undefined
    );
    const changesRoutingMode = routingMode !== undefined && routingMode !== (current.routingMode ?? "manual");
    if (changesAgentConfiguration || changesRoutingMode) {
      try {
        dependencies.store.assertDuoComparisonTurnAllowed(
          conversationId,
        );
      } catch (error) {
        throw new RuntimeRequestError(
          error instanceof Error
            ? error.message
            : "That judge chat is reserved for a Duo comparison.",
        );
      }
    }
    // The routing mode only affects the next message, so it may change during a run.
    if (
      changesAgentConfiguration
      && dependencies.store.hasActiveWorkspaceRunForConversation(
        conversationId,
      )
    ) {
      throw new RuntimeRequestError(
        "Stop the active run or review before changing its agent configuration.",
      );
    }
    const canonicalUpdate = canonicalSelection && canonicalProviderId
      ? {
          ...update,
          providerId: canonicalProviderId,
          modelSelection: canonicalSelection,
        }
      : update;
    if (canonicalSelection) {
      delete canonicalUpdate.model;
      delete canonicalUpdate.reasoningEffort;
    }
    return dependencies.store.updateConversation(conversationId, {
      ...canonicalUpdate,
      ...(routingMode !== undefined ? { routingMode } : {}),
      ...(resetProviderSession
        ? {
            providerSessionId: null,
            continuationIdentity: null,
          }
        : restoredProviderSession ?? {}),
      pinnedAt: pinned === undefined
        ? current.pinnedAt ?? null
        : pinned ? new Date().toISOString() : null,
      snoozedUntil: snoozedUntil === undefined
        ? current.snoozedUntil ?? null
        : snoozedUntil,
    });
  }
}
