import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InputRequestCard } from "../../src/renderer/src/components/AgentRequestCard";
import type { AgentInputRequest } from "../../src/shared/contracts";

const request: AgentInputRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  providerId: "claude",
  conversationId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  autoResolutionMs: null,
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Choose the implementation scope",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [
        {
          id: "focused",
          label: "Focused",
          description: "Only the active workflow.",
        },
        {
          id: "broad",
          label: "Broad",
          description: "Every compatible workflow.",
        },
      ],
    },
    {
      id: "note",
      header: "Note",
      question: "Add a handoff note",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [],
    },
  ],
};

describe("InputRequestCard question pager", () => {
  it("preserves answers across accessible question navigation and submits only when complete", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => undefined);
    const { container } = render(<InputRequestCard request={request} onRespond={onRespond} />);

    const navigation = screen.getByLabelText("Question navigation");
    expect(within(navigation).getByText("1 of 2")).toBeVisible();
    expect(screen.getByRole("group", { name: /Choose the implementation scope/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Broad/u }));
    expect(screen.getByRole("button", { name: "Go to question 1" })).toHaveAttribute("data-answered", "true");
    await user.click(screen.getByRole("button", { name: "Next question" }));

    expect(within(navigation).getByText("2 of 2")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Add a handoff note" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit answers and continue" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Add a handoff note" }), "Keep reduced motion truthful");

    await user.click(screen.getByRole("button", { name: "Go to question 1" }));
    expect(screen.getByRole("radio", { name: /Broad/u })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Go to question 2" }));
    expect(screen.getByRole("textbox", { name: "Add a handoff note" })).toHaveValue("Keep reduced motion truthful");
    await user.click(screen.getByRole("button", { name: "Submit answers and continue" }));

    expect(onRespond).toHaveBeenCalledWith(request, {
      scope: ["broad"],
      note: ["Keep reduced motion truthful"],
    });
    expect(container.querySelectorAll(".agent-input-page-dots > button")).toHaveLength(2);
  });
});
