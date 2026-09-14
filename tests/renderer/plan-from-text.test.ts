import { expect, it } from "vitest";
import { planFromText } from "../../src/renderer/src/utils/planFromText";

it("uses the live turn plan instead of marking the previous answer in progress", () => {
  expect(planFromText("1. Previous task", "running", "1. Current task\n2. Verify result"))
    .toEqual([
      { id: "step-0", title: "Current task", status: "in-progress" },
      { id: "step-1", title: "Verify result", status: "pending" },
    ]);
  expect(planFromText("1. Previous task", "running", "")).toEqual([]);
});

it("uses the persisted final answer after the turn completes", () => {
  expect(planFromText("1. Final task", "completed", "1. Earlier streamed text"))
    .toEqual([{ id: "step-0", title: "Final task", status: "completed" }]);
});
