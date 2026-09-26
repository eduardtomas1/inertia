import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationHistoryControls } from "../../src/renderer/src/components/ConversationHistoryControls";
import type { ConversationContentResult, ConversationDeferredContent } from "../../src/shared/contracts";
import { deferred } from "./composer-fixtures";

const item: ConversationDeferredContent = { kind: "message", id: "answer", label: "assistant answer", cursor: "first", totalBytes: 100_000 };
const content = (text: string, nextCursor: string | null): ConversationContentResult => ({
  kind: "conversation.content", conversationId: "chat", text, nextCursor, offsetBytes: 0, totalBytes: item.totalBytes,
});

describe("bounded conversation history controls", () => {
  it("can return to live history after the last page or all displayed records are deleted", () => {
    const latest = vi.fn();
    render(<ConversationHistoryControls history={{ olderCursor: null, newerCursor: null, recordCount: 0 }} viewingHistory loading={false} onLatest={latest} />);
    fireEvent.click(screen.getByRole("button", { name: "Latest history" }));
    expect(latest).toHaveBeenCalledOnce();
  });
  it("navigates history explicitly and disables requests while loading", () => {
    const onOlder = vi.fn(), onNewer = vi.fn(), onLatest = vi.fn();
    const props = { history: { olderCursor: "older", newerCursor: "newer", recordCount: 24 }, onOlder, onNewer, onLatest };
    const view = render(<ConversationHistoryControls {...props} loading={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Older history" }));
    fireEvent.click(screen.getByRole("button", { name: "Newer history" }));
    fireEvent.click(screen.getByRole("button", { name: "Latest history" }));
    expect(onOlder).toHaveBeenCalledOnce(); expect(onNewer).toHaveBeenCalledOnce(); expect(onLatest).toHaveBeenCalledOnce();
    view.rerender(<ConversationHistoryControls {...props} loading />);
    expect(screen.getByRole("button", { name: "Older history" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Latest history" })).toBeDisabled();
  });

  it("reads all text through bounded replacement pages and can return to the prior part", async () => {
    const readContent = vi.fn(async (cursor: string) => cursor === "first" ? content("first <script> segment", "second") : content("second segment", null));
    render(<ConversationHistoryControls deferredContent={[item]} loading={false} readContent={readContent} />);
    expect(readContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Long content is previewed (1)"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Read full assistant answer" })); });
    const text = screen.getByLabelText("Stored text segment");
    expect(text).toHaveTextContent("first <script> segment");
    expect(text.querySelector("script")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next part" })); });
    expect(screen.getByLabelText("Stored text segment")).toHaveTextContent("second segment");
    expect(screen.queryByText("first <script> segment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next part" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Previous part" })); });
    expect(readContent.mock.calls.map(([cursor]) => cursor)).toEqual(["first", "second", "first"]);
  });

  it("ignores late content after closing and exposes stale-cursor failures without stale text", async () => {
    const pending = deferred<ConversationContentResult>();
    const readContent = vi.fn(() => pending.promise);
    render(<ConversationHistoryControls deferredContent={[item]} loading={false} readContent={readContent} />);
    fireEvent.click(screen.getByText("Long content is previewed (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Read full assistant answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Close full content" }));
    await act(async () => pending.resolve(content("late content", null)));
    expect(screen.queryByText("late content")).toBeNull();
    readContent.mockRejectedValueOnce(new Error("Content changed"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Read full assistant answer" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("content changed");
    expect(screen.queryByLabelText("Stored text segment")).toBeNull();
  });
});
