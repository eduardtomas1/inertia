import { useMemo } from "react";

import type { Conversation } from "@shared/contracts";
import {
  ROUTING_TASK_KIND_LABELS,
  ROUTING_TIER_LABELS,
  type RoutingDecisionSummary,
  type RoutingMode,
} from "@shared/routing/routing-policy";
import type { SelectedModelChipProps } from "../SelectedModelChip";
import { AUTO_ROUTING_OVERRIDE_HINT, type ModelChooserAutoOption } from "./ModelChooserAutoRow";

const PICKER_LABELS: Readonly<Record<RoutingDecisionSummary["picker"], string>> = {
  rules: "Rules",
};

const OUTCOME_LABELS: Readonly<Record<RoutingDecisionSummary["outcome"], string>> = {
  applied: "Switched model",
  kept: "Kept model",
  fallback: "Fallback",
  "low-confidence": "Low confidence",
};

/**
 * The decision line of the composer tooltip and the chip's accessible name.
 * The route line already names the model and effort, so the picker's free-text
 * reason, which repeats them, is left out.
 */
export function routingDecisionText(decision: RoutingDecisionSummary): string {
  return [
    `${PICKER_LABELS[decision.picker]} picker`,
    ROUTING_TASK_KIND_LABELS[decision.taskKind],
    `${ROUTING_TIER_LABELS[decision.tier]} tier`,
    `${Math.round(decision.confidence * 100)}% confidence`,
    OUTCOME_LABELS[decision.outcome],
  ].join(" · ");
}

/**
 * The chip names only the model: the effort control beside it already shows
 * the effort. The tooltip and accessible name keep the full route.
 */
export function autoRouteChipOverride(
  routeLabel: string,
  reasoningLabel: string | null,
  decision: RoutingDecisionSummary | null,
): NonNullable<SelectedModelChipProps["override"]> {
  const route = [routeLabel, reasoningLabel].filter(Boolean).join(" · ");
  const explanation = decision
    ? routingDecisionText(decision)
    : "Auto chooses a model when you send the next message.";
  return {
    label: `Auto · ${routeLabel}`,
    tooltip: [`Auto routing → ${route}`, explanation, AUTO_ROUTING_OVERRIDE_HINT].join("\n"),
    accessibleName: `Choose model. Auto routing is on; currently ${route}. ${decision ? `${explanation}.` : explanation} ${AUTO_ROUTING_OVERRIDE_HINT}`,
  };
}

export interface AutoRoutingState {
  active: boolean;
  chooserOption?: ModelChooserAutoOption;
  chipOverride?: SelectedModelChipProps["override"];
  /** Fields added to a concrete model choice; picking a model overrides Auto. */
  manualOverride: { routingMode?: RoutingMode };
}

/**
 * Presentation state for Auto routing in one composer. The runtime owns the
 * decision; this only offers Auto when Settings enable it and shows the last
 * recorded decision.
 */
export function useAutoRouting({
  enabled,
  conversation,
  decision,
  routeLabel,
  reasoningLabel,
  onUpdateConversation,
}: {
  enabled: boolean;
  conversation: Pick<Conversation, "routingMode">;
  decision: RoutingDecisionSummary | null;
  routeLabel: string;
  reasoningLabel: string | null;
  onUpdateConversation: (update: { routingMode: RoutingMode }) => Promise<void>;
}): AutoRoutingState {
  const active = enabled && conversation.routingMode === "auto";
  return useMemo(() => {
    if (!enabled) return { active: false, manualOverride: {} };
    const route = [routeLabel, reasoningLabel].filter(Boolean).join(" · ");
    return {
      active,
      chooserOption: {
        selected: active,
        currentRoute: route || null,
        onSelect: () => onUpdateConversation({ routingMode: "auto" }),
      },
      ...(active ? { chipOverride: autoRouteChipOverride(routeLabel, reasoningLabel, decision) } : {}),
      manualOverride: active ? { routingMode: "manual" } : {},
    };
  }, [active, decision, enabled, onUpdateConversation, reasoningLabel, routeLabel]);
}
