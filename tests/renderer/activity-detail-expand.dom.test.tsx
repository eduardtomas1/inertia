import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import {
  ACTIVITY_DETAIL_READ_FAILED,
  ActivityDetailReaderContext,
  createActivityDetailReader,
  type ActivityDetailReader,
} from "../../src/renderer/src/components/response-timeline/activityDetailContext";
import type { AgentActivity, ServerEvent } from "../../src/shared/contracts";

const full = ["Command:", "npm test", "", "Output:", ...Array.from({ length: 400 }, (_, index) => `output line ${index}`)].join("\n");

const preview: AgentActivity = {
  id: "activity-1",
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "run-1",
  turnId: "turn-1",
  kind: "command",
  title: "npm test",
  detail: full.slice(0, 2_048),
  detailBytes: full.length,
  detailTruncated: true,
  status: "completed",
  createdAt: "2026-07-27T08:00:00.000Z",
};

function renderRow(reader: ActivityDetailReader, activity: AgentActivity = preview) {
  return render(
    <ActivityDetailReaderContext.Provider value={reader}>
      <ActivityRow activity={activity} visibility="details" />
    </ActivityDetailReaderContext.Provider>,
  );
}

describe("activity output on demand", () => {
  it("reads the full output only when the row is expanded", async () => {
    const reader = vi.fn<ActivityDetailReader>(async () => full);
    const { container } = renderRow(reader, { ...preview, id: "activity-expand" });
    expect(reader).not.toHaveBeenCalled();
    const disclosure = screen.getByRole("button", { name: /^Output:/u });
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading the full output");
    await waitFor(() => expect(container.querySelector(".agent-activity-output")).toHaveTextContent("output line 399"));
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(preview.conversationId, "activity-expand");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(disclosure);
    fireEvent.click(disclosure);
    expect(container.querySelector(".agent-activity-output")).toHaveTextContent("output line 399");
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview and offers a retry when the read fails", async () => {
    const reader = vi.fn<ActivityDetailReader>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(full);
    const { container } = renderRow(reader, { ...preview, id: "activity-retry" });
    fireEvent.click(screen.getByRole("button", { name: /^Output:/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ACTIVITY_DETAIL_READ_FAILED);
    expect(container.querySelector(".agent-activity-output")).toHaveTextContent("output line 0");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(container.querySelector(".agent-activity-output")).toHaveTextContent("output line 399"));
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("never reads when the detail is already complete", () => {
    const reader = vi.fn<ActivityDetailReader>(async () => full);
    const { container } = renderRow(reader, { ...preview, detail: full, detailBytes: undefined, detailTruncated: undefined });
    fireEvent.click(screen.getByRole("button", { name: /^Output:/u }));
    expect(container.querySelector(".agent-activity-output")).toHaveTextContent("output line 399");
    expect(reader).not.toHaveBeenCalled();
  });

  it("refuses a read result for another activity", async () => {
    const request = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result", requestId: "read",
      result: { kind: "activity.detail", conversationId: preview.conversationId, activityId: "other", turnId: "turn-1", detail: "foreign" },
    }));
    await expect(createActivityDetailReader(request)(preview.conversationId, preview.id)).rejects.toThrow(ACTIVITY_DETAIL_READ_FAILED);
    expect(request).toHaveBeenCalledWith({ type: "activity.detail.read", payload: { conversationId: preview.conversationId, activityId: preview.id } });
  });
});
