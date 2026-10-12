import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

const activity: AgentActivity = {
  id: "activity-1",
  conversationId: "conversation-1",
  runId: "run-1",
  turnId: "turn-1",
  kind: "command",
  title: "Command",
  detail: "Command:\n/bin/bash -lc 'cd /workspace && npm test -- tests/renderer/a-very-long-path.test.ts'",
  status: "completed",
  createdAt: "2026-07-27T08:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("activity row label", () => {
  it("shows the full row label in the shared tooltip on hover and no native title", () => {
    const { container } = render(<ActivityRow activity={activity} visibility="recent" />);
    const row = container.querySelector<HTMLElement>(".agent-activity")!;
    expect(container.querySelector("[title]")).toBeNull();
    vi.useFakeTimers();
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector('[role="tooltip"]'))
      .toHaveTextContent("Ran npm test -- tests/renderer/a-very-long-path.test.ts");
    fireEvent.pointerLeave(row, { pointerType: "mouse" });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
