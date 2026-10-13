// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { planSteps as kimiPlanSteps } from "../../src/server/provider/kimi-acp-projection";
import { todoStep as openCodeTodoStep } from "../../src/server/provider/opencode-sdk-support";

describe("provider plan step statuses", () => {
  it("maps every Kimi ACP plan entry status", () => {
    expect(kimiPlanSteps([
      { content: "Inspect", status: "completed" },
      { content: "Implement", status: "in_progress" },
      { content: "Rewrite", status: "cancelled" },
      { content: "Verify", status: "pending" },
    ])).toEqual([
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "inProgress" },
      { step: "Rewrite", status: "cancelled" },
      { step: "Verify", status: "pending" },
    ]);
  });

  it("maps every OpenCode todo status", () => {
    expect([
      { content: "Inspect", status: "completed", priority: "high" },
      { content: "Implement", status: "in_progress", priority: "high" },
      { content: "Rewrite", status: "cancelled", priority: "low" },
      { content: "Verify", status: "pending", priority: "medium" },
    ].flatMap(openCodeTodoStep)).toEqual([
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "inProgress" },
      { step: "Rewrite", status: "cancelled" },
      { step: "Verify", status: "pending" },
    ]);
  });
});
