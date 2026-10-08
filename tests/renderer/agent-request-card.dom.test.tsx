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

const databaseQuestion: AgentInputRequest = {
  ...request,
  questions: [{
    id: "database",
    header: "Database",
    question: "Which database should the sync service write to?",
    isOther: true,
    isSecret: false,
    allowMultiple: false,
    options: [
      { id: "postgres", label: "PostgreSQL (Recommended)", description: "Matches the billing schema." },
      { id: "sqlite", label: "SQLite", description: "Simplest locally." },
    ],
  }],
};

describe("InputRequestCard question steps", () => {
  it("preserves answers across accessible step navigation and submits only when complete", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => undefined);
    render(<InputRequestCard request={request} onRespond={onRespond} />);

    const steps = screen.getByRole("tablist", { name: "Questions" });
    expect(within(steps).getByRole("tab", { name: "Scope" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Claude has 2 questions")).toBeVisible();
    expect(screen.getByRole("group", { name: /Choose the implementation scope/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Broad/u }));
    expect(within(steps).getByRole("tab", { name: "Scope" })).toHaveAttribute("data-answered", "true");
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(within(steps).getByRole("tab", { name: "Note" })).toHaveAttribute("aria-selected", "true");
    const note = await screen.findByRole("textbox", { name: "Add a handoff note" });
    expect(note).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    await user.type(note, "Keep reduced motion truthful");

    await user.click(within(steps).getByRole("tab", { name: "Scope" }));
    expect(await screen.findByRole("radio", { name: /Broad/u })).toBeChecked();
    await user.click(within(steps).getByRole("tab", { name: "Note" }));
    expect(await screen.findByRole("textbox", { name: "Add a handoff note" })).toHaveValue("Keep reduced motion truthful");
    await user.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onRespond).toHaveBeenCalledWith(request, {
      scope: ["broad"],
      note: ["Keep reduced motion truthful"],
    });
  });

  it("lets a typed answer replace a single choice without losing it when switching back", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => undefined);
    render(<InputRequestCard request={databaseQuestion} onRespond={onRespond} />);

    expect(screen.getByText("Claude has a question")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeVisible();
    expect(screen.getByRole("radio", { name: /^PostgreSQL Recommended/u })).toBeInTheDocument();
    expect(screen.getByText("Choose one, or type your own")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /SQLite/u }));
    const custom = screen.getByRole("textbox", { name: "Something else" });
    await user.type(custom, "CockroachDB");
    expect(screen.getByRole("radio", { name: /SQLite/u })).not.toBeChecked();

    await user.click(screen.getByRole("radio", { name: /SQLite/u }));
    expect(custom).toHaveValue("CockroachDB");
    await user.click(custom);
    expect(screen.getByRole("radio", { name: /SQLite/u })).not.toBeChecked();

    await user.keyboard("{Enter}");
    expect(onRespond).toHaveBeenCalledWith(databaseQuestion, { database: ["CockroachDB"] });
  });

  it("chooses options with number keys and sends with Enter", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn(async () => undefined);
    render(<InputRequestCard request={databaseQuestion} onRespond={onRespond} />);

    screen.getByRole("radio", { name: /^PostgreSQL/u }).focus();
    await user.keyboard("2");
    expect(screen.getByRole("radio", { name: /SQLite/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /SQLite/u })).toHaveFocus();
    await user.keyboard("3");
    expect(screen.getByRole("textbox", { name: "Something else" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: /SQLite/u })).toBeChecked();

    await user.keyboard("{Enter}");
    expect(onRespond).toHaveBeenCalledWith(databaseQuestion, { database: ["sqlite"] });
  });
});
