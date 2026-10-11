import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TerminalResumeStatus } from "../../src/renderer/src/components/TerminalResumeStatus";
import type { ProviderTerminalResumeOption } from "../../src/renderer/src/components/providerResumeOptions";

const option: ProviderTerminalResumeOption = {
  projectId: "project-1",
  projectName: "Inertia",
  conversationId: "first",
  conversationTitle: "First chat",
  availability: {
    kind: "available",
    resume: { providerId: "codex", providerLabel: "Codex", sessionId: "019fe0c1-c6fc-79a1-bff4-92311f314da8" },
    reason: null,
  },
};

describe("terminal resume status", () => {
  it("shows the session id as plain text without a native title", () => {
    const { container } = render(
      <TerminalResumeStatus
        selectedResumeOption={option}
        resumeOptions={[option]}
        activeResume={null}
        siblingResumedConversationIds={new Set()}
        resumeBlockedBySibling={false}
        resumeInFlight={false}
        sessionState="ready"
        status="online"
        projectName="Inertia"
        resumeError={null}
        onSelect={vi.fn()}
        onResume={vi.fn(() => true)}
      />,
    );
    const code = container.querySelector("code");
    expect(code).toHaveTextContent("019fe0c1-c6fc-79a1-bff4-92311f314da8");
    expect(code).not.toHaveAttribute("title");
  });

  it("names the chat to resume through the trigger alone, without a caption", () => {
    const second = { ...option, conversationId: "second", conversationTitle: "Second chat" };
    const { container } = render(
      <TerminalResumeStatus
        selectedResumeOption={option}
        resumeOptions={[option, second]}
        activeResume={null}
        siblingResumedConversationIds={new Set()}
        resumeBlockedBySibling={false}
        resumeInFlight={false}
        sessionState="ready"
        status="online"
        projectName="Inertia"
        resumeError={null}
        onSelect={vi.fn()}
        onResume={vi.fn(() => true)}
      />,
    );
    expect(container.querySelector(".terminal-resume-picker-caption")).toBeNull();
    expect(container.querySelector(".terminal-resume-trigger")).toHaveAccessibleName("Chat to resume: First chat in Inertia");
  });
});
