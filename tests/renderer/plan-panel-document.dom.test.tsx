import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentPlan, ChatMessage, Conversation } from "../../src/shared/contracts";
import { PlanPanel, type PlanStep } from "../../src/renderer/src/components/PlanPanel";
import { TaskCreationContext, type TaskCreator } from "../../src/renderer/src/components/tasks/taskCreation";
import { usePlanSteps } from "../../src/renderer/src/hooks/usePlanSteps";
import { EMPTY_STREAMING_AGENT_SOURCE } from "../../src/renderer/src/hooks/useStreamingAgentState";
import { planDocument, planInlineSegments } from "../../src/renderer/src/utils/planDocument";
import {
  reportedPlanStepCount,
  textPlanGate,
  visiblePlanSteps,
} from "../../src/renderer/src/utils/planFromText";
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

  it("shows Implement and Refine disabled while the plan actions are busy", () => {
    const steps = [{ id: "step", title: "Write the projection", status: "pending" as const }];
    const { rerender } = render(<PlanPanel steps={steps} actionsDisabled onRefine={() => undefined} onImplement={() => undefined} />);
    expect((screen.getByRole("button", { name: "Implement" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Refine plan" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<PlanPanel steps={steps} onRefine={() => undefined} onImplement={() => undefined} />);
    expect((screen.getByRole("button", { name: "Implement" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Refine plan" }) as HTMLButtonElement).disabled).toBe(false);
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
    const turns = [{ id: "plan-run-turn" }, { id: "build-run-turn" }];
    const { container } = render(<PlanPanel document={latestPlanDocument(plans, turns)} markdown={markdown} steps={result.current} />);

    expect(screen.getByRole("heading", { level: 2, name: "Ship the fix" })).toBeTruthy();
    expect(container.querySelector(".plan-document h2")?.textContent).toBe("Context");
    expect(screen.getByText("2 of 3 complete")).toBeTruthy();
    expect([...container.querySelectorAll("[data-plan-step-status]")].map((step) => step.getAttribute("data-plan-step-status")))
      .toEqual(["completed", "completed", "in-progress"]);
    expect(latestPlanDocument([...plans, record("revised-run", "# Plan: Revised", [])], [...turns, { id: "revised-run-turn" }]))
      .toBe("# Plan: Revised");
    expect(latestPlanDocument([record("blank-run", "  ", [])], [{ id: "blank-run-turn" }])).toBeNull();
    expect(latestPlanDocument([], [])).toBeNull();
  });

  describe("pairs the document with the newest checklist", () => {
    const record = (turnId: string, explanation: string | null): AgentPlan => ({
      conversationId: "conversation",
      runId: `${turnId}-run`,
      turnId,
      explanation,
      steps: [{ step: "Run the tests", status: explanation ? "pending" : "inProgress" }],
    });
    const turns = (...ids: string[]) => ids.map((id) => ({ id }));
    const planned = record("plan", "# Plan: Ship the fix");

    it("keeps the document for the build turn's checklist", () => {
      expect(latestPlanDocument([planned, record("build", null)], turns("plan", "build"))).toBe("# Plan: Ship the fix");
    });

    it("keeps the document through a continue turn that also reports the checklist", () => {
      expect(latestPlanDocument(
        [planned, record("build", null), record("continue", null)],
        turns("plan", "build", "continue"),
      )).toBe("# Plan: Ship the fix");
    });

    it("drops the document when turns without a plan separate it from the checklist", () => {
      expect(latestPlanDocument(
        [planned, record("checklist", null)],
        turns("plan", "question", "answer", "checklist"),
      )).toBeNull();
    });

    it("keeps a document whose turn is on an older page when every loaded turn before the checklist has a plan", () => {
      expect(latestPlanDocument([planned, record("build", null)], turns("build"))).toBe("# Plan: Ship the fix");
      expect(latestPlanDocument([planned, record("build", null)], turns("question", "build"))).toBeNull();
    });

    it("keeps the document of a newest plan whose turn is on an older page", () => {
      expect(latestPlanDocument([planned], turns("question", "answer"))).toBe("# Plan: Ship the fix");
    });

    it("keeps the document while the checklist turn is not yet in the loaded turns", () => {
      expect(latestPlanDocument([planned, record("build", null)], turns("plan"))).toBe("# Plan: Ship the fix");
    });

    it("does not pair a live checklist whose turn is not loaded yet with a document on an older page", () => {
      const live = record("build", null);
      expect(latestPlanDocument([planned, live], turns("question", "answer"), [planned])).toBeNull();
      expect(latestPlanDocument([planned, live], turns("plan"), [planned])).toBe("# Plan: Ship the fix");
      expect(latestPlanDocument([planned, live], turns("question", "answer"), [planned, live])).toBe("# Plan: Ship the fix");
    });

    it("keeps the document of a newest plan and its checklist when both turns are on an older page", () => {
      expect(latestPlanDocument([record("old", "# Plan: Old")], turns("question", "answer"))).toBe("# Plan: Old");
      expect(latestPlanDocument([planned, record("build", null)], turns("question", "answer"))).toBe("# Plan: Ship the fix");
      expect(latestPlanDocument([record("build", null)], turns("question", "answer"))).toBeNull();
    });

    it("pairs an on-page checklist with a document on an older page only through planned turns", () => {
      expect(latestPlanDocument(
        [planned, record("build", null), record("continue", null)],
        turns("build", "continue"),
      )).toBe("# Plan: Ship the fix");
      expect(latestPlanDocument(
        [planned, record("build", null), record("continue", null)],
        turns("build", "question", "continue"),
      )).toBeNull();
    });
  });

  describe("plan derived from the reply", () => {
    const reply: ChatMessage = {
      id: "reply",
      conversationId: "conversation",
      turnId: "reply-turn",
      role: "assistant",
      content: "Here is the approach:\n1. Read the adapter\n2. Write the projection",
      attachments: [],
      createdAt: "2026-10-13T12:00:00.000Z",
    };
    const derivedSteps = (mode: "plan" | "build") => {
      const { result } = renderHook(() => usePlanSteps([], [reply], "completed", EMPTY_STREAMING_AGENT_SOURCE));
      return visiblePlanSteps(
        result.current,
        textPlanGate([reply], [{ id: "reply-turn", interactionMode: mode }], mode),
      );
    };

    it("shows nothing for a build-mode reply's list", () => {
      const steps = derivedSteps("build");
      expect(steps).toEqual([]);
      expect(reportedPlanStepCount(steps)).toBe(0);
      render(<PlanPanel steps={steps} onRefine={() => undefined} onImplement={() => undefined} />);
      expect(screen.getByText("No plan yet")).toBeTruthy();
      expect(screen.queryByText("Derived from the reply")).toBeNull();
    });

    it("labels a plan-mode reply's list as derived without completing it", () => {
      const steps = derivedSteps("plan");
      expect(reportedPlanStepCount(steps)).toBe(0);
      const refine = vi.fn();
      const implement = vi.fn();
      const { container } = render(<PlanPanel steps={steps} onRefine={refine} onImplement={implement} />);

      expect(screen.getByText("Derived from the reply")).toBeTruthy();
      expect(screen.queryByText(/of \d+ complete/u)).toBeNull();
      const note = screen.getByText(/didn't report a plan/u);
      const list = container.querySelector(".plan-steps")!;
      expect(list.getAttribute("aria-describedby")).toBe(note.id);
      expect([...container.querySelectorAll("[data-plan-step-status]")].map((step) => step.getAttribute("data-plan-step-status")))
        .toEqual(["pending", "pending"]);
      expect(screen.queryByText("Completed")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Refine plan" }));
      fireEvent.click(screen.getByRole("button", { name: "Implement" }));
      expect(refine).toHaveBeenCalledTimes(1);
      expect(implement).toHaveBeenCalledTimes(1);
    });

    it("keeps a native plan's progress and count unlabeled", () => {
      const native: AgentPlan = {
        conversationId: "conversation",
        runId: "run",
        turnId: "reply-turn",
        explanation: null,
        steps: [
          { step: "Read the adapter", status: "completed" },
          { step: "Write the projection", status: "inProgress" },
        ],
      };
      const { result } = renderHook(() => usePlanSteps([native], [reply], "completed", EMPTY_STREAMING_AGENT_SOURCE));
      const steps = visiblePlanSteps(result.current, { streamed: false, derived: false });
      expect(reportedPlanStepCount(steps)).toBe(2);
      render(<PlanPanel steps={steps} />);
      expect(screen.getByText("1 of 2 complete")).toBeTruthy();
      expect(screen.queryByText("Derived from the reply")).toBeNull();
    });
  });
});

describe("plan step tasks", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const chat = { id: conversationId, projectId: "project", title: "Release prep" } as Conversation;
  const steps: PlanStep[] = [
    { id: "native", title: "**Verify** the `Authorization` header", detail: "Check both tokens.", status: "completed", source: "native" },
    { id: "streamed", title: "Ship the fix", status: "in-progress", source: "streamed" },
  ];
  const derivedSteps: PlanStep[] = [
    { id: "derived", title: "Write the changelog", status: "pending", source: "derived" },
  ];

  function renderPanel(
    taskCreator: TaskCreator | null,
    props: Partial<React.ComponentProps<typeof PlanPanel>> = {},
  ) {
    return render(
      <TaskCreationContext.Provider value={taskCreator}>
        <PlanPanel steps={steps} markdown={{ ...markdown, conversationId }} {...props} />
      </TaskCreationContext.Provider>,
    );
  }

  it("creates a task linked to the chat from a step, with its plain title, source and detail", () => {
    const create = vi.fn<TaskCreator["create"]>();
    renderPanel({ create }, { onSelectStep: vi.fn() });
    const button = screen.getByRole("button", { name: "Create task from step 1: Verify the Authorization header" });
    expect(button.closest("li")).toHaveClass("has-task-action");
    expect(button.closest(".plan-step-button")).toBeNull();
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(create).toHaveBeenCalledOnce();
    const [linked, compose] = create.mock.calls[0]!;
    expect(linked).toBe(conversationId);
    expect(compose(chat)).toEqual({
      title: "Verify the Authorization header",
      note: "From the plan in Release prep\n\nCheck both tokens.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Create task from step 2: Ship the fix" }));
    expect(create.mock.calls[1]![1](chat)).toEqual({ title: "Ship the fix", note: "From the plan in Release prep" });
  });

  it("offers the action for steps derived from the reply", () => {
    const create = vi.fn<TaskCreator["create"]>();
    renderPanel({ create }, { steps: derivedSteps });
    expect(screen.getByText("Derived from the reply")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create task from step 1: Write the changelog" }));
    expect(create.mock.calls[0]![1](chat)).toEqual({
      title: "Write the changelog", note: "From the plan in Release prep",
    });
  });

  it("hides the action without a saved chat or outside the main window", () => {
    const { unmount } = renderPanel({ create: vi.fn() }, { markdown });
    expect(screen.queryByRole("button", { name: /^Create task/u })).toBeNull();
    unmount();
    renderPanel(null);
    expect(screen.queryByRole("button", { name: /^Create task/u })).toBeNull();
    expect(document.querySelector(".has-task-action")).toBeNull();
  });
});

describe("plan implementation actions", () => {
  const steps: PlanStep[] = [
    { id: "step-0", title: "Write the adapter", status: "pending" },
    { id: "step-1", title: "Cover it", status: "pending" },
  ];

  it("offers Implement in a new chat beside Implement, with the same busy state", () => {
    const implementInNewChat = vi.fn();
    const { rerender } = render(<PlanPanel steps={steps} actionsDisabled onImplement={() => undefined} onImplementInNewChat={implementInNewChat} />);
    expect((screen.getByRole("button", { name: "Implement in a new chat" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<PlanPanel steps={steps} onImplement={() => undefined} onImplementInNewChat={implementInNewChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Implement in a new chat" }));
    expect(implementInNewChat).toHaveBeenCalledTimes(1);
  });
});
