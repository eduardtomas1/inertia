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
