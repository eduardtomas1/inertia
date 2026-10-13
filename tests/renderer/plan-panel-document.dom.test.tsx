import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentPlan } from "../../src/shared/contracts";
import { PlanPanel } from "../../src/renderer/src/components/PlanPanel";
import { usePlanSteps } from "../../src/renderer/src/hooks/usePlanSteps";
import { EMPTY_STREAMING_AGENT_SOURCE } from "../../src/renderer/src/hooks/useStreamingAgentState";
import { planDocument, planInlineSegments } from "../../src/renderer/src/utils/planDocument";
import { latestPlanDocument } from "../../src/renderer/src/utils/terminalTurnProjection";

const markdown = { projectRoot: "/workspace", projectId: "project", defaultCodeWrap: true };
const plan = [
  "# Plan: bot de Google Chat interactivo",
  "## Context",
  "El bot solo envía avisos desde `notify_failure.sh` y **no responde**.",
  ...Array.from({ length: 24 }, (_, index) => `- Paso ${index + 1}`),
].join("\n");

describe("plan panel document", () => {
  it("takes the title from the plan heading and keeps the body as markdown", () => {
    expect(planDocument(plan).title).toBe("Bot de Google Chat interactivo");
    expect(planDocument(plan).body.startsWith("## Context")).toBe(true);
    expect(planDocument("Just steps\n- one")).toEqual({ title: null, body: "Just steps\n- one" });
    expect(planInlineSegments("Use `POST /` and **verify**")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "POST /" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "verify" },
    ]);
  });

  it("renders the plan as markdown, collapses long plans and formats step titles", () => {
    const { container } = render(
      <PlanPanel
        document={plan}
        markdown={markdown}
        steps={[{ id: "step", title: "**Verificación**: validar `Authorization`", status: "pending" }]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Bot de Google Chat interactivo" })).toBeTruthy();
    const document = container.querySelector(".plan-document")!;
    expect(document.querySelector("h2")?.textContent).toBe("Context");
    expect(document.querySelector("strong")?.textContent).toBe("no responde");
    expect(document.textContent).not.toContain("**");
    expect(document.classList.contains("is-collapsed")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Show full plan" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.classList.contains("is-collapsed")).toBe(false);
    const step = container.querySelector(".plan-step-title")!;
    expect(step.querySelector("strong")?.textContent).toBe("Verificación");
    expect(step.querySelector("code")?.textContent).toBe("Authorization");
    expect(screen.getByRole("button", { name: "Copy plan" })).toBeTruthy();
  });

  it("shows an empty plan as one line without a count, progress, helper or actions", () => {
    const { container } = render(<PlanPanel steps={[]} onRefine={() => undefined} onImplement={() => undefined} />);
    expect(screen.getByText("No plan yet")).toBeTruthy();
    expect(screen.queryByText(/of 0 complete/u)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".plan-summary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refine plan" })).toBeNull();
    expect(container.querySelector(".panel-heading > svg")).toBeNull();
  });

  it("shows a document-only plan without the empty state", () => {
    render(<PlanPanel document={"# Plan: Short\nOne paragraph."} markdown={markdown} steps={[]} />);
    expect(screen.queryByText("No plan yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show full plan" })).toBeNull();
    expect(screen.getByText("One paragraph.")).toBeTruthy();
  });

  it("keeps the plan document while a later run reports progress on its steps", () => {
    const record = (runId: string, explanation: string | null, steps: AgentPlan["steps"]): AgentPlan => ({
      conversationId: "conversation",
      runId,
      turnId: `${runId}-turn`,
      explanation,
      steps,
    });
    const plans = [
      record("plan-run", "# Plan: Ship the fix\n## Context\nThe adapter drops progress.", [
        { step: "Inspect the adapter", status: "pending" },
        { step: "Write the projection", status: "pending" },
        { step: "Run the tests", status: "pending" },
      ]),
      record("build-run", null, [
        { step: "Inspect the adapter", status: "completed" },
        { step: "Write the projection", status: "completed" },
        { step: "Run the tests", status: "inProgress" },
      ]),
    ];
    const { result } = renderHook(() => usePlanSteps(plans, [], "running", EMPTY_STREAMING_AGENT_SOURCE));
    const { container } = render(<PlanPanel document={latestPlanDocument(plans)} markdown={markdown} steps={result.current} />);

    expect(screen.getByRole("heading", { level: 2, name: "Ship the fix" })).toBeTruthy();
    expect(container.querySelector(".plan-document h2")?.textContent).toBe("Context");
    expect(screen.getByText("2 of 3 complete")).toBeTruthy();
    expect([...container.querySelectorAll("[data-plan-step-status]")].map((step) => step.getAttribute("data-plan-step-status")))
      .toEqual(["completed", "completed", "in-progress"]);
    expect(latestPlanDocument([...plans, record("revised-run", "# Plan: Revised", [])])).toBe("# Plan: Revised");
    expect(latestPlanDocument([record("blank-run", "  ", [])])).toBeNull();
    expect(latestPlanDocument([])).toBeNull();
  });
});
