import type {
  Conversation,
  ModelBackendProfileView,
  ProviderInfo,
  TurnRequestContext,
} from "../../../shared/contracts";
import type { ModelSelection } from "../../../shared/model-routing";
import { effectiveRoutingPresets } from "../../../shared/routing/routing-catalog";
import { routingAttachmentKind, type RoutingInput } from "../../../shared/routing/routing-features";
import { effectiveRoutingRoute, planRoutingDecision } from "../../../shared/routing/routing-planner";
import type { ProviderId } from "../../../shared/provider";
import type {
  RoutingDecisionSummary,
  RoutingPickerId,
  RoutingPreset,
} from "../../../shared/routing/routing-policy";
import {
  ROUTING_PICKER_IMPLEMENTATIONS,
  type PickerResult,
  type RoutingPicker,
} from "../../../shared/routing/routing-rules-picker";
import type { RuntimeStore } from "../../database";
import type { ConversationUpdateService } from "../conversation-update-service";
import { applyRoutingPlan, restoreRoutingPlan, routingSummary, type RoutingRestorePoint } from "./apply";
import {
  currentRoutingRoute,
  routingCandidateSelection,
  runtimeRoutingCatalog,
} from "./catalog";

/** A picker that does not answer in time keeps the current route. */
export const ROUTING_PICKER_TIMEOUT_MS = 2_000;

export interface RouteAdvisorDependencies {
  store: Pick<RuntimeStore, "conversation"> & {
    settings: Pick<RuntimeStore["settings"], "current">;
    turnLedgerRepository: Pick<RuntimeStore["turnLedgerRepository"], "routingHistory">;
  };
  providerInfo(): readonly ProviderInfo[];
  backendProfiles(): readonly ModelBackendProfileView[];
  /** The authoritative selection validator (BackendProfileController.validateSelection). */
  validateSelection(selection: ModelSelection): ModelSelection;
  updates: Pick<ConversationUpdateService, "update">;
  /** Test seam; production uses the shared implementations. */
  pickers?: Partial<Record<RoutingPickerId, RoutingPicker>>;
}

export interface RouteBeforeTurnInput {
  conversationId: string;
  content: string;
  attachments: readonly { mimeType: string }[];
  /** Prepared inputs that need image input even without an image attachment (scanned PDF pages). */
  requiresVision?: boolean;
  /** The send path's own per-request image limit, checked for each candidate provider. */
  imageLimitRefusal?: (providerId: ProviderId) => string | null;
  context?: TurnRequestContext;
}

/** One routing decision for the turn about to be queued. */
export interface RoutingTurnDecision {
  summary: RoutingDecisionSummary | null;
  /** Present when the route changed, so an unready route can be undone. */
  restore: RoutingRestorePoint | null;
}

/** Whether the next fresh turn of this chat goes through Auto routing. */
export function autoRoutingApplies(
  settings: { routing: { enabled: boolean } },
  conversation: Pick<Conversation, "routingMode">,
): boolean {
  return settings.routing.enabled && conversation.routingMode === "auto";
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The routing picker timed out.")), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Chooses the route for the next turn of an Auto chat. The decision never
 * bypasses validateSelection → resolveModelRoute → resolveContinuationDecision:
 * candidates are validated before scoring and applied through the same
 * conversation update service the renderer uses. Routing failures keep the
 * current route; they never fail the user's message.
 */
export class RouteAdvisor {
  constructor(private readonly dependencies: RouteAdvisorDependencies) {}

  /**
   * The chat may change while the picker runs, so a caller that gets a
   * decision re-reads the conversation before continuing with the turn.
   */
  async routeBeforeTurn(input: RouteBeforeTurnInput): Promise<RoutingTurnDecision | null> {
    try {
      return await this.route(input);
    } catch {
      return null;
    }
  }

  /**
   * Restores the route Auto replaced when the routed one fails readiness.
   * Returns the decision to record (outcome `kept`); throws only when the
   * validated restore itself is refused.
   */
  restorePreviousRoute(decision: RoutingTurnDecision, reason: string): RoutingDecisionSummary | null {
    if (!decision.restore) return decision.summary;
    const { conversationId } = decision.restore;
    return restoreRoutingPlan({
      updates: this.dependencies.updates,
      reread: () => this.dependencies.store.conversation(conversationId),
      restore: decision.restore,
      summary: decision.summary,
      reason,
    });
  }

  private async route(input: RouteBeforeTurnInput): Promise<RoutingTurnDecision | null> {
    const { dependencies } = this;
    const settings = dependencies.store.settings.current();
    if (!settings.routing.enabled) return null;
    const conversation = dependencies.store.conversation(input.conversationId);
    if (!autoRoutingApplies(settings, conversation)) return null;
    const history = dependencies.store.turnLedgerRepository.routingHistory(conversation.id);
    const routingInput: RoutingInput = {
      content: input.content,
      attachments: input.attachments.map(({ mimeType }) => routingAttachmentKind(mimeType)),
      fileReferenceCount: input.context?.fileReferences?.length ?? 0,
      chatMentionCount: input.context?.conversationContextPacketIds?.length ?? 0,
      priorTurnCount: history.turnCount,
      previousTurnFailed: history.latestTurn?.status === "failed",
      previousTier: history.lastRoutedTier,
    };
    const pickerId = settings.routing.picker;
    let picked: PickerResult;
    try {
      const picker = dependencies.pickers?.[pickerId] ?? ROUTING_PICKER_IMPLEMENTATIONS[pickerId];
      picked = await withTimeout(picker(routingInput), ROUTING_PICKER_TIMEOUT_MS);
    } catch {
      return {
        summary: routingSummary({
          picker: pickerId,
          tier: settings.routing.fallbackTier,
          taskKind: "other",
          confidence: 0,
          outcome: "kept",
          reason: "The routing picker could not decide, so the current model stays.",
        }),
        restore: null,
      };
    }
    try {
      const providers = dependencies.providerInfo();
      const backendProfiles = dependencies.backendProfiles();
      const catalog = runtimeRoutingCatalog(providers, backendProfiles, history.latestTurn);
      const selections = new Map<RoutingPreset, ModelSelection>();
      const plan = planRoutingDecision({
        settings: settings.routing,
        picked,
        presets: effectiveRoutingPresets(settings.routing, catalog, settings.defaultProvider),
        catalog,
        current: effectiveRoutingRoute(currentRoutingRoute(conversation), catalog),
        hasPriorTurns: history.turnCount > 0,
        requiresVision: input.requiresVision === true || routingInput.attachments.includes("image"),
        validate: (candidate) => {
          const imageLimit = input.imageLimitRefusal?.(candidate.preset.providerId) ?? null;
          if (imageLimit) return "too many images for this provider";
          try {
            selections.set(candidate.preset, dependencies.validateSelection(
              routingCandidateSelection(candidate, providers, backendProfiles),
            ));
            return null;
          } catch {
            return "the route failed validation";
          }
        },
      });
      const applied = applyRoutingPlan({
        updates: dependencies.updates,
        conversation,
        reread: () => dependencies.store.conversation(conversation.id),
        picker: pickerId,
        picked,
        plan,
        selection: plan.candidate ? selections.get(plan.candidate.preset) ?? null : null,
      });
      return { summary: applied.summary, restore: applied.restore };
    } catch {
      return {
        summary: routingSummary({
          picker: pickerId,
          tier: picked.tier,
          taskKind: picked.taskKind,
          confidence: picked.confidence,
          outcome: "kept",
          reason: "Routing could not finish, so the current model stays.",
        }),
        restore: null,
      };
    }
  }
}
