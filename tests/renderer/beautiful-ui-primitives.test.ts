import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PlanPanel } from "../../src/renderer/src/components/PlanPanel";

describe("Beautiful UI primitive adaptations", () => {
  it("renders plan steps as truthful connected task states", () => {
    const html = renderToStaticMarkup(
      createElement(PlanPanel, {
        steps: [
          {
            id: "inspect",
            title: "Inspect provider state",
            status: "completed",
          },
          {
            id: "build",
            title: "Build the interaction",
            status: "in-progress",
          },
          { id: "verify", title: "Verify the result", status: "pending" },
        ],
        activeStepId: "build",
        onSelectStep: vi.fn(),
      }),
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('data-plan-step-status="completed"');
    expect(html).toContain('data-plan-step-status="in-progress"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("In progress");
  });
});
