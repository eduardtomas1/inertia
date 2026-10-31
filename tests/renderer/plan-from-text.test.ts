import { describe, expect, it } from "vitest";
import {
  PLAN_IMPLEMENTATION_MAX_BYTES,
  planFromText,
  planImplementationMessage,
  reportedPlanStepCount,
  textPlanGate,
  visiblePlanSteps,
} from "../../src/renderer/src/utils/planFromText";
import { withProvisionalLatestTurn } from "../../src/renderer/src/utils/terminalTurnProjection";
import type { ChatMessage } from "../../src/shared/contracts";

it("uses the live turn plan instead of marking the previous answer in progress", () => {
  expect(planFromText("1. Previous task", "running", "1. Current task\n2. Verify result"))
    .toEqual([
      { id: "step-0", title: "Current task", status: "in-progress", source: "streamed" },
      { id: "step-1", title: "Verify result", status: "pending", source: "streamed" },
    ]);
  expect(planFromText("1. Previous task", "running", "")).toEqual([]);
});

it("derives pending steps from the persisted final answer after the turn completes", () => {
  expect(planFromText("1. Final task", "completed", "1. Earlier streamed text"))
    .toEqual([{ id: "step-0", title: "Final task", status: "pending", source: "derived" }]);
});

it("never auto-completes or progresses derived steps", () => {
  for (const status of ["completed", "idle", "failed", "needs-input", "running"] as const) {
    expect(planFromText("- First step\n- Second step", status).map((step) => step.status))
      .toEqual(["pending", "pending"]);
  }
});

describe("text plan gate", () => {
  const assistant = (turnId: string | null) => ({ role: "assistant" as const, turnId });
  const user = (turnId: string | null) => ({ role: "user" as const, turnId });
  const planTurn = { id: "plan-turn", interactionMode: "plan" as const, status: "running" as const };
  const buildTurn = { id: "build-turn", interactionMode: "build" as const, status: "running" as const };
  const derived = planFromText("1. Ship it\n2. Verify it", "completed");
  const streamed = planFromText("", "running", "1. Ship it\n2. Verify it");
  const native = [{ id: "native-0", title: "Ship it", status: "completed" as const, source: "native" as const }];
  const closed = { streamed: false, derived: false };

  it("allows a derived plan only when the latest finished reply came from a plan-mode turn", () => {
    const turns = [planTurn, buildTurn];
    expect(textPlanGate([user("plan-turn"), assistant("plan-turn")], [planTurn], "build").derived).toBe(true);
    expect(textPlanGate([assistant("plan-turn"), assistant("build-turn")], turns, "plan").derived).toBe(false);
    expect(textPlanGate([assistant("build-turn"), user("next")], turns, "plan").derived).toBe(false);
  });

  it("allows streamed steps only when the running turn is in plan mode", () => {
    expect(textPlanGate([assistant("build-turn")], [buildTurn, planTurn], "build").streamed).toBe(true);
    expect(textPlanGate([assistant("plan-turn")], [planTurn, buildTurn], "plan").streamed).toBe(false);
  });

  it("does not let a finished earlier turn decide the reply that is streaming now", () => {
    const finishedPlan = { ...planTurn, status: "completed" as const };
    const messages = [user("plan-turn"), assistant("plan-turn"), user(null)];
    expect(textPlanGate(messages, [finishedPlan], "build", "build-turn").streamed).toBe(false);
    expect(textPlanGate(messages, [finishedPlan], "build", null).streamed).toBe(false);
    expect(textPlanGate(messages, [finishedPlan], "build", "plan-turn").streamed).toBe(true);
    expect(textPlanGate(messages, [finishedPlan], "build", "build-turn").derived).toBe(true);
    const finishedBuild = { ...buildTurn, status: "completed" as const };
    expect(textPlanGate([], [finishedBuild], "plan", "next-turn").streamed).toBe(true);
    expect(textPlanGate([], [{ ...buildTurn, status: "waiting-for-input" as const }], "plan", "next-turn").streamed).toBe(false);
  });

  it("falls back to the conversation mode only when the turn is not projected", () => {
    expect(textPlanGate([assistant("missing")], [], "plan")).toEqual({ streamed: true, derived: true });
    expect(textPlanGate([assistant(null)], [], "build")).toEqual(closed);
    expect(textPlanGate([], [], "plan")).toEqual({ streamed: true, derived: false });
    expect(textPlanGate([assistant(null)], [], null)).toEqual(closed);
  });

  it("hides derived steps outside plan mode and never counts them in the badge", () => {
    expect(visiblePlanSteps(derived, closed)).toEqual([]);
    expect(visiblePlanSteps(derived, { streamed: false, derived: true })).toBe(derived);
    expect(reportedPlanStepCount(visiblePlanSteps(derived, { streamed: true, derived: true }))).toBe(0);
  });

  it("hides a Build-mode turn's streamed list and keeps a Plan-mode turn's progress", () => {
    const build = visiblePlanSteps(streamed, { streamed: false, derived: true });
    expect(build).toEqual([]);
    expect(reportedPlanStepCount(build)).toBe(0);

    const plan = visiblePlanSteps(streamed, { streamed: true, derived: false });
    expect(plan).toBe(streamed);
    expect(plan.map(({ status }) => status)).toEqual(["in-progress", "pending"]);
    expect(reportedPlanStepCount(plan)).toBe(2);
  });

  it("never gates a native provider plan", () => {
    expect(visiblePlanSteps(native, closed)).toBe(native);
    expect(reportedPlanStepCount(visiblePlanSteps(native, closed))).toBe(1);
  });
});

describe("provisional latest turn", () => {
  const latest = {
    id: "turn-new",
    runId: "run-new",
    status: "running",
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "builtin:openai",
    modelSelection: { alias: null, backendConfigurationRevision: 0 },
    continuationIdentity: {},
    model: "model",
    reasoningEffort: "medium",
    requestedAt: "2026-10-26T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    terminalReason: null,
    updatedAt: "2026-10-26T10:00:00.000Z",
  };
  const liveMessages = [{ id: "message-new", role: "user", turnId: "turn-new" }] as unknown as ChatMessage[];
  const shell = (summary: Record<string, unknown>, interactionMode: "build" | "plan") => ({
    id: "conversation",
    latestTurn: summary,
    interactionMode,
    accessMode: "supervised",
  }) as unknown as Parameters<typeof withProvisionalLatestTurn>[1];

  it("stamps the turn with the mode it was sent in, not the chat's current mode", () => {
    const sentInBuild = withProvisionalLatestTurn([], shell({ ...latest, interactionMode: "build" }, "plan"), liveMessages);
    expect(sentInBuild.at(-1)?.interactionMode).toBe("build");
    const legacy = withProvisionalLatestTurn([], shell(latest, "plan"), liveMessages);
    expect(legacy.at(-1)?.interactionMode).toBe("plan");
  });
});

describe("plan implementation message", () => {
  const steps = [
    { title: "Write the adapter", detail: "Keep it pure.", source: "native" as const },
    { title: "Cover it", source: "native" as const },
  ];

  it("sends the plan document itself instead of pointing at the reply above", () => {
    const message = planImplementationMessage({ document: "# Plan\n\n1. Write the adapter\n2. Cover it\n", steps });
    expect(message).toBe("Implement this plan and validate the result.\n\n# Plan\n\n1. Write the adapter\n2. Cover it");
    expect(message).not.toMatch(/plan above/u);
  });

  it("writes the steps out when there is no plan document", () => {
    expect(planImplementationMessage({ document: null, steps })).toBe([
      "Implement this plan and validate the result.",
      "",
      "1. Write the adapter",
      "   Keep it pure.",
      "2. Cover it",
    ].join("\n"));
  });

  it("keeps the Derived from the reply label for a plan read from a reply", () => {
    const derived = steps.map((step) => ({ ...step, source: "derived" as const }));
    const message = planImplementationMessage({ document: null, steps: derived });
    expect(message.split("\n")[1]).toMatch(/^Derived from the reply/u);
    expect(planImplementationMessage({ document: null, steps })).not.toMatch(/Derived from the reply/u);
  });

  it("trims plan text over 16 KiB at a line boundary and says so", () => {
    const line = `- ${"é".repeat(60)}`;
    const document = Array.from({ length: 400 }, (_, index) => `${index}${line}`).join("\n");
    expect(new TextEncoder().encode(document).byteLength).toBeGreaterThan(PLAN_IMPLEMENTATION_MAX_BYTES);
    const message = planImplementationMessage({ document, steps });
    const lines = message.split("\n");
    expect(lines.at(-1)).toBe("The plan above was trimmed to its first 16 KiB.");
    const planText = lines.slice(2, -2).join("\n");
    expect(new TextEncoder().encode(planText).byteLength).toBeLessThanOrEqual(PLAN_IMPLEMENTATION_MAX_BYTES);
    expect(document.startsWith(planText)).toBe(true);
    expect(document.charAt(planText.length)).toBe("\n");

    const fits = "x".repeat(PLAN_IMPLEMENTATION_MAX_BYTES);
    expect(planImplementationMessage({ document: fits, steps })).not.toMatch(/trimmed/u);
  });
});
