import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProviderResumePicker } from "../../src/renderer/src/components/ProviderResumePicker";
import type { ProviderTerminalResumeOption } from "../../src/renderer/src/components/providerResumeOptions";

const available = (
  conversationId: string,
  conversationTitle: string,
): ProviderTerminalResumeOption => ({
  projectId: "project-1",
  projectName: "Inertia",
  conversationId,
  conversationTitle,
  availability: {
    kind: "available",
    resume: {
      providerId: "claude",
      providerLabel: "Claude",
      sessionId: `session-${conversationId}`,
    },
    reason: null,
  },
});

const unavailable: ProviderTerminalResumeOption = {
  projectId: "project-1",
  projectName: "Inertia",
  conversationId: "unavailable",
  conversationTitle: "Unavailable chat",
  availability: {
    kind: "unavailable",
    resume: null,
    reason: "This session cannot be resumed.",
  },
};

describe("ProviderResumePicker", () => {
  it("initializes and synchronizes Enter to the selected selectable row", async () => {
    const onSelect = vi.fn();
    const first = available("first", "First chat");
    const second = available("second", "Second chat");
    const view = render(
      <ProviderResumePicker
        options={[unavailable, first, second]}
        selectedConversationId="second"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("option", { name: /Second chat/u }))
      .toHaveAttribute("data-active", "true");
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("second");

    view.rerender(
      <ProviderResumePicker
        options={[unavailable, first, second]}
        selectedConversationId="first"
        onSelect={onSelect}
      />,
    );
    await waitFor(() => expect(screen.getByRole("option", { name: /First chat/u }))
      .toHaveAttribute("data-active", "true"));
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("first");
  });

  it("reveals a truncated session id in the shared tooltip", async () => {
    const { container } = render(<ProviderResumePicker options={[available("first", "First chat")]} selectedConversationId="first" onSelect={vi.fn()} />);
    const code = container.querySelector("code")!;
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    fireEvent.pointerEnter(code.firstElementChild ?? code, { pointerType: "mouse" });
    await waitFor(() => expect(document.querySelector('[role="tooltip"]')).toHaveTextContent("session-first"));
  });

  it("shows a one-line empty state and no keyboard hint row", () => {
    const view = render(<ProviderResumePicker options={[]} selectedConversationId={null} onSelect={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^No resumable chats$/u);
    expect(view.container.querySelector(".resume-picker-footer")).toBeNull();
    view.rerender(<ProviderResumePicker options={[available("first", "First chat")]} selectedConversationId="first" onSelect={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing matches" } });
    expect(screen.getByRole("status")).toHaveTextContent(/^No matching chats$/u);
  });

  it("never defaults or arrows onto an unavailable row", () => {
    const onSelect = vi.fn();
    render(
      <ProviderResumePicker
        options={[unavailable, available("first", "First chat"), available("last", "Last chat")]}
        selectedConversationId={null}
        onSelect={onSelect}
      />,
    );

    const search = screen.getByRole("searchbox");
    expect(screen.getByRole("option", { name: /First chat/u }))
      .toHaveAttribute("data-active", "true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /Last chat/u }))
      .toHaveAttribute("data-active", "true");
    expect(screen.getByRole("option", { name: /Unavailable chat/u }))
      .not.toHaveAttribute("data-active");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("last");
  });
});
