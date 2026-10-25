import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ContextCompactionRow,
  PendingContextCompaction,
} from "../../src/renderer/src/components/response-timeline/ContextCompactionRow";
import { responseTimelineArticleLabel } from "../../src/renderer/src/components/response-timeline/row-label";
import { estimateTimelineRowSize } from "../../src/renderer/src/utils/response-timeline/virtualization";
import type { ChatMessage } from "../../src/shared/contracts";
import type { ContextCompactionTrigger } from "../../src/shared/context-compaction";

function receipt(trigger?: ContextCompactionTrigger, content = "/compact"): ChatMessage {
  return {
    id: `receipt-${trigger ?? "legacy"}`,
    conversationId: "conversation",
    turnId: null,
    role: "system",
    content,
    attachments: [],
    createdAt: "2026-10-25T10:20:00.000Z",
    compaction: {
      providerId: "claude",
      beforeTokens: 252_000,
      afterTokens: 18_300,
      instructionForwarded: false,
      ...(trigger ? { trigger } : {}),
    },
  };
}

describe("compaction timeline rows", () => {
  it("renders a compaction on return as one row without a /compact bubble", () => {
    const { container } = render(<ContextCompactionRow message={receipt("on-return", "")} />);

    const separator = screen.getByRole("separator", { name: "Compacted on return 252K → 18.3K tokens" });
    expect(separator.querySelector(".context-compaction-marker"))
      .toHaveTextContent("Compacted on return·252K → 18.3K tokens");
    expect(container.querySelector(".turn-user-request")).toBeNull();
    expect(container.querySelector("section")).toHaveAttribute("data-compaction-trigger", "on-return");
    expect(container.querySelector("section")).toHaveAccessibleName("Compacted on return 252K → 18.3K tokens");
  });

  it("keeps the manual /compact request bubble with the same token label style", () => {
    const { container } = render(<ContextCompactionRow message={receipt("manual", "/compact keep the API decisions")} />);

    expect(screen.getByRole("separator", { name: "Compacted context 252K → 18.3K tokens" })
      .querySelector(".context-compaction-marker"))
      .toHaveTextContent("Compacted context·252K → 18.3K tokens");
    expect(container.querySelector(".turn-user-request")).toHaveTextContent("/compact keep the API decisions");
  });

  it("labels compaction rows by trigger for navigation", () => {
    expect(responseTimelineArticleLabel({ kind: "compaction", id: "a", message: receipt("on-return", "") }))
      .toBe("Compacted on return 252K → 18.3K tokens");
    expect(responseTimelineArticleLabel({ kind: "compaction", id: "b", message: receipt() }))
      .toBe("Compacted context 252K → 18.3K tokens");
  });

  it("estimates an on-return row as a single separator", () => {
    const onReturn = estimateTimelineRowSize({ kind: "compaction", id: "a", message: receipt("on-return", "") });
    const manual = estimateTimelineRowSize({ kind: "compaction", id: "b", message: receipt("manual", "/compact") });
    expect(onReturn).toBeLessThan(manual);
  });

  it.each([
    ["manual" as const, "Compacting context"],
    ["on-return" as const, "Compacting before sending"],
  ])("shows a live row while a %s compaction runs", (trigger, label) => {
    render(
      <PendingContextCompaction
        since="2026-10-25T10:20:00.000Z"
        trigger={trigger}
        items={[]}
        elapsed={<span>3s</span>}
      />,
    );
    const separator = screen.getByRole("separator", { name: label });
    expect(separator).toHaveAttribute("data-compaction-state", "live");
    expect(separator.querySelector(".context-compaction-marker")).toHaveTextContent(`${label}·3s`);
  });
});
