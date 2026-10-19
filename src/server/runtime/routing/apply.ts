import { isDeepStrictEqual } from "node:util";

import type { Conversation } from "../../../shared/contracts";
import { modelSelectionSchema, type ModelSelection } from "../../../shared/model-routing";
import type { PickerResult } from "../../../shared/routing/routing-rules-picker";
import type { RoutingPlan } from "../../../shared/routing/routing-planner";
import {
  boundedRoutingReason,
  safeRoutingDecisionSummary,
  type RoutingDecisionSummary,
  type RoutingPickerId,
  type RoutingRouteReference,
  type RoutingTier,
  type RoutingTaskKind,
} from "../../../shared/routing/routing-policy";
import { publicRuntimeError } from "../../runtime-errors";
import type { ConversationUpdateService } from "../conversation-update-service";
import { currentRoutingRoute } from "./catalog";

/** The route a chat had before Auto changed it, kept so an unready route can be undone. */
export interface RoutingRestorePoint {
  conversationId: string;
  previous: Pick<Conversation, "providerId" | "modelSelection">;
  applied: ModelSelection;
}

export interface RoutingApplyResult {
  conversation: Conversation;
  summary: RoutingDecisionSummary | null;
  restore: RoutingRestorePoint | null;
}

export const CHAT_CHANGED_WHILE_ROUTING = "Kept the current model: the chat changed while routing.";

function routeReference(conversation: Pick<Conversation, "providerId" | "modelSelection">): RoutingRouteReference {
  const route = currentRoutingRoute(conversation);
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    reasoningEffort: route.reasoningEffort || null,
  };
}

/**
 * Builds a schema-valid decision summary. A previous route outside the
 * schema is dropped; an unusable summary becomes null. It never throws.
 */
export function routingSummary(input: {
  picker: RoutingPickerId;
  tier: RoutingTier;
  taskKind: RoutingTaskKind;
  confidence: number;
  outcome: RoutingDecisionSummary["outcome"];
  reason: string;
  previousRoute?: RoutingRouteReference | null;
}): RoutingDecisionSummary | null {
  return safeRoutingDecisionSummary({
    picker: input.picker,
    tier: input.tier,
    taskKind: input.taskKind,
    confidence: Number.isFinite(input.confidence) ? Math.min(1, Math.max(0, input.confidence)) : 0,
    outcome: input.outcome,
    reason: boundedRoutingReason(input.reason),
    previousRoute: input.previousRoute ?? null,
  });
}

function sameRoute(
  left: Pick<Conversation, "providerId" | "modelSelection">,
  right: Pick<Conversation, "providerId" | "modelSelection">,
): boolean {
  return left.providerId === right.providerId && isDeepStrictEqual(left.modelSelection, right.modelSelection);
}

/**
 * Turns a plan into the validated conversation update. The chat is re-read
 * before every outcome, so a mode or model change made while the picker ran
 * always wins (outcome `kept`) and the returned conversation is never the
 * stale snapshot. A refused update keeps the current route and records why;
 * it never fails the message.
 */
export function applyRoutingPlan(input: {
  updates: Pick<ConversationUpdateService, "update">;
  /** The conversation the plan was made from. */
  conversation: Conversation;
  /** Re-reads the conversation immediately before the update. */
  reread: () => Conversation;
  picker: RoutingPickerId;
  picked: PickerResult;
  plan: RoutingPlan;
  selection: ModelSelection | null;
}): RoutingApplyResult {
  const { conversation, plan, picked, picker } = input;
  const summary = (
    outcome: RoutingDecisionSummary["outcome"],
    reason: string,
    previousRoute: RoutingRouteReference | null = null,
  ) => routingSummary({
    picker,
    tier: plan.tier,
    taskKind: picked.taskKind,
    confidence: picked.confidence,
    outcome,
    reason,
    previousRoute,
  });
  const settledOutcome: RoutingDecisionSummary["outcome"] = plan.fallback
    ? "fallback"
    : plan.lowConfidence ? "low-confidence" : "kept";
  const refused = (error: unknown): RoutingApplyResult => ({
    conversation,
    summary: summary("kept", `Kept the current model: ${publicRuntimeError(error)} (${plan.reason})`),
    restore: null,
  });
  // Every outcome is checked against a fresh read, so the caller never
  // continues with the snapshot the (possibly slow) picker started from.
  let latest: Conversation;
  try {
    latest = input.reread();
  } catch (error) {
    return refused(error);
  }
  if (latest.routingMode !== "auto" || !sameRoute(latest, conversation)) {
    return { conversation: latest, summary: summary("kept", CHAT_CHANGED_WHILE_ROUTING), restore: null };
  }
  if (!plan.changesRoute || !input.selection || !plan.candidate) {
    return { conversation: latest, summary: summary(settledOutcome, plan.reason), restore: null };
  }
  try {
    const applied = modelSelectionSchema.parse(input.selection);
    const updated = input.updates.update({
      conversationId: conversation.id,
      providerId: plan.candidate.preset.providerId,
      modelSelection: applied,
    }, "auto-routing");
    return {
      conversation: updated,
      summary: summary(
        plan.fallback || plan.lowConfidence ? settledOutcome : "applied",
        plan.reason,
        routeReference(conversation),
      ),
      restore: {
        conversationId: conversation.id,
        previous: { providerId: conversation.providerId, modelSelection: conversation.modelSelection },
        applied: updated.modelSelection,
      },
    };
  } catch (error) {
    return { ...refused(error), conversation: latest };
  }
}

/**
 * Undoes an applied route that turned out not to be ready, through the same
 * validated update. A chat changed by someone else since is left alone.
 */
export function restoreRoutingPlan(input: {
  updates: Pick<ConversationUpdateService, "update">;
  reread: () => Conversation;
  restore: RoutingRestorePoint;
  summary: RoutingDecisionSummary | null;
  reason: string;
}): RoutingDecisionSummary | null {
  const { restore, summary } = input;
  const kept = (reason: string) => summary
    ? routingSummary({ ...summary, outcome: "kept", reason, previousRoute: null })
    : null;
  const latest = input.reread();
  if (!isDeepStrictEqual(latest.modelSelection, restore.applied)) {
    return kept(CHAT_CHANGED_WHILE_ROUTING);
  }
  input.updates.update({
    conversationId: restore.conversationId,
    providerId: restore.previous.providerId,
    modelSelection: modelSelectionSchema.parse(restore.previous.modelSelection),
  }, "auto-routing");
  return kept(`Kept the current model: the routed model is not ready (${input.reason})`);
}
