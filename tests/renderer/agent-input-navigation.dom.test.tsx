import { describe, expect, it, vi } from "vitest";

import { revealAgentInputRequest } from "../../src/renderer/src/utils/agentInputNavigation";

describe("agent input navigation", () => {
  it("reveals and focuses the first control for the requested provider question", () => {
    const scrollIntoView = vi.fn();
    const request = document.createElement("section");
    request.id = "agent-input-request-question-1";
    request.scrollIntoView = scrollIntoView;
    const input = document.createElement("input");
    request.append(input);
    document.body.append(request);

    expect(revealAgentInputRequest("question-1")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
    expect(input).toHaveFocus();

    request.remove();
  });

  it("does nothing while a virtualized request has not mounted yet", () => {
    expect(revealAgentInputRequest("missing-question")).toBe(false);
  });
});
