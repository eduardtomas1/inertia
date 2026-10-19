import { describe, expect, it } from "vitest";
import {
  planFromText,
  reportedPlanStepCount,
  textPlanGate,
  visiblePlanSteps,
} from "../../src/renderer/src/utils/planFromText";

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
  const planTurn = { id: "plan-turn", interactionMode: "plan" as const };
  const buildTurn = { id: "build-turn", interactionMode: "build" as const };
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
