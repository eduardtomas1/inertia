import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentPlan } from "../../src/shared/contracts";
import { PlanPanel } from "../../src/renderer/src/components/PlanPanel";
import { PlanDetail } from "../../src/renderer/src/components/response-timeline/activity";
import { usePlanSteps } from "../../src/renderer/src/hooks/usePlanSteps";
import { EMPTY_STREAMING_AGENT_SOURCE } from "../../src/renderer/src/hooks/useStreamingAgentState";

const plan: AgentPlan = {
  conversationId: "conversation",
  runId: "run",
  turnId: "turn",
  explanation: null,
  steps: [
    { step: "Inspect provider state", status: "completed" },
    { step: "Rewrite the adapter", status: "cancelled" },
  ],
};

describe("cancelled native plan steps", () => {
  it("keeps cancelled steps distinct from completed work", () => {
    const { result } = renderHook(() =>
      usePlanSteps([plan], [], "completed", EMPTY_STREAMING_AGENT_SOURCE));
    expect(result.current.map(({ status }) => status)).toEqual(["completed", "cancelled"]);

    render(<PlanPanel steps={result.current} />);
    expect(screen.getByText("1 of 2 complete")).toBeTruthy();
    expect(screen.getByLabelText("50% complete")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(document.querySelector('[data-plan-step-status="cancelled"]')).not.toBeNull();
  });

  it("does not mark cancelled steps done in the turn plan detail", () => {
    render(<PlanDetail plan={plan} />);
    expect(screen.getByText(/Rewrite the adapter/u).textContent)
      .toBe("✓ Inspect provider state\n✕ Rewrite the adapter");
  });
});
