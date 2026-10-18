import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard, InputRequestCard } from "../../src/renderer/src/components/AgentRequestCard";
import type { AgentApprovalRequest, AgentInputRequest } from "../../src/shared/contracts";

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
    expect(within(navigation).getByRole("button", { name: "Go to question 1" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("group", { name: /Choose the implementation scope/u })).toBeVisible();
    expect(screen.getByRole("button", { name: /Next/u })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Broad/u }));
    expect(screen.getByRole("button", { name: "Go to question 1" })).toHaveAttribute("data-answered", "true");
    await user.click(screen.getByRole("button", { name: /Next/u }));

    expect(within(navigation).getByRole("button", { name: "Go to question 2" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox", { name: "Add a handoff note" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Add a handoff note" }), "Keep reduced motion truthful");

    await user.click(screen.getByRole("button", { name: "Go to question 1" }));
    expect(screen.getByRole("radio", { name: /Broad/u })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Go to question 2" }));
    expect(screen.getByRole("textbox", { name: "Add a handoff note" })).toHaveValue("Keep reduced motion truthful");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onRespond).toHaveBeenCalledWith(request, {
      scope: ["broad"],
      note: ["Keep reduced motion truthful"],
    });
    expect(container.querySelectorAll(".agent-input-page-dots > button")).toHaveLength(2);
  });

  it("shows the provider's short question header as plain text above the question", () => {
    render(<InputRequestCard request={request} onRespond={vi.fn(async () => undefined)} />);

    const group = screen.getByRole("group", { name: /Choose the implementation scope/u });
    const header = within(group).getByText("Scope");
    expect(header).toBeVisible();
    expect(header).toHaveClass("agent-input-question-header");
    expect(header.closest("legend")).not.toBeNull();
  });

  it("omits an empty question header", () => {
    const blank: AgentInputRequest = {
      ...request,
      questions: [{ ...request.questions[0]!, header: "  " }],
    };
    const { container } = render(<InputRequestCard request={blank} onRespond={vi.fn(async () => undefined)} />);

    expect(container.querySelector(".agent-input-question-header")).toBeNull();
  });
});

const approval: AgentApprovalRequest = {
  id: "55555555-5555-4555-8555-555555555555",
  providerId: "codex",
  conversationId: request.conversationId,
  runId: request.runId,
  turnId: request.turnId,
  kind: "command",
  title: "Approve command",
  detail: null,
  command: "npm test",
  cwd: null,
  reason: null,
  networkScope: null,
  permissionRoots: [],
  availableDecisions: ["cancel", "deny", "approve"],
};

function Workspace({ card, composer = true }: { card: React.ReactNode; composer?: boolean }): React.JSX.Element {
  return (
    <main className="chat-workspace">
      <section className="response-turn" aria-label="Turn 1" tabIndex={-1}>{card}</section>
      {composer && <section aria-label="Message composer"><textarea aria-label="Message" /></section>}
    </main>
  );
}

describe("request card focus after an answer", () => {
  it("moves focus to the composer once an approval is answered and the card leaves", async () => {
    const user = userEvent.setup();
    const view = render(<Workspace card={<ApprovalCard request={approval} onRespond={vi.fn(async () => undefined)} />} />);

    await user.click(screen.getByRole("button", { name: "Approve once" }));
    view.rerender(<Workspace card={null} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("moves focus to the composer once a question is answered", async () => {
    const user = userEvent.setup();
    render(<Workspace card={<InputRequestCard request={{ ...request, questions: [request.questions[0]!] }} onRespond={vi.fn(async () => undefined)} />} />);

    await user.click(screen.getByRole("radio", { name: /Broad/u }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("falls back to the turn when the chat has no composer", async () => {
    const user = userEvent.setup();
    render(<Workspace composer={false} card={<ApprovalCard request={approval} onRespond={vi.fn(async () => undefined)} />} />);

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(screen.getByRole("region", { name: "Turn 1" })).toHaveFocus();
  });

  it("leaves focus alone when the user moved on before the answer was accepted", async () => {
    const user = userEvent.setup();
    let accept!: () => void;
    const onRespond = vi.fn(() => new Promise<void>((resolve) => { accept = resolve; }));
    render(
      <>
        <Workspace card={<ApprovalCard request={approval} onRespond={onRespond} />} />
        <button type="button">Open settings</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Approve once" }));
    screen.getByRole("button", { name: "Open settings" }).focus();
    await act(async () => accept());

    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
  });
});

describe("request card answer failures", () => {
  it("keeps focus on the card and handles the failure when an answer is refused", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => { throw new Error("The request already ended."); });
    render(<ApprovalCard request={approval} onRespond={onRespond} />);
    const approve = screen.getByRole("button", { name: "Approve once" });

    await user.click(approve);
    await act(async () => { await Promise.resolve(); });

    expect(onRespond).toHaveBeenCalledOnce();
    expect(approve).toBeEnabled();
    expect(approve).toHaveFocus();
  });
});
