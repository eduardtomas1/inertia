import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SnapshotRequest } from "../../src/shared/snapshots";
import type { SnapshotReview } from "../../src/shared/snapshot-review";
import { ReviewedScreenshotControl } from "../../src/renderer/src/components/composer/ReviewedScreenshotControl";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";

const original = window.inertia;
const state = { enabled: false, shortcut: "accelerator" as const, available: false, permission: "unverified" as const, message: null };
const snapshot = vi.fn(async (_request: SnapshotRequest) => state);
const chat = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  window.inertia = { ...original, snapshot };
});
afterEach(() => { window.inertia = original; vi.restoreAllMocks(); snapshot.mockClear(); });
const deliver = (review: SnapshotReview, conversationId = chat) => act(async () => {
  window.dispatchEvent(new CustomEvent("inertia:snapshot-review", { detail: { conversationId, review } }));
});
async function start() {
  screen.getByRole("button", { name: "Take reviewed screenshot" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Take reviewed screenshot" }));
  await waitFor(() => expect(snapshot).toHaveBeenCalled());
  return (snapshot.mock.calls[0] as unknown as [{ reviewId: string }])[0].reviewId;
}
const preview = (reviewId: string, revision = 1) => ({ stage: "image" as const, reviewId, revision, width: 100, height: 80, preview: "data:image/png;base64,fixture" });

it("offers manual capture while protected snapshots are disabled, and never auto-approves a preview", async () => {
  render(<ReviewedScreenshotControl conversationId={chat} />);
  const id = await start();
  expect(snapshot).toHaveBeenCalledWith({ type: "review-start", reviewId: id, conversationId: chat });
  expect(screen.getByText(/Automatic masking is not verified/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel screenshot" })).toHaveFocus();
  expect(nativePreviewSuspended()).toBe(true);
  await deliver({ reviewId: id, stage: "sources", sources: [{ id: "source", name: "Example window", preview: "data:image/png;base64,fixture" }] });
  fireEvent.click(screen.getByRole("button", { name: "Example window" }));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "review-select", reviewId: id, sourceId: "source" });
  await deliver(preview(id));
  expect(snapshot).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Attach reviewed image" }));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "review-approve", reviewId: id, revision: 1 });
  await deliver({ reviewId: id, stage: "closed" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(nativePreviewSuspended()).toBe(false);
  expect(screen.getByRole("button", { name: "Take reviewed screenshot" })).toHaveFocus();
});

it("supports keyboard crop and masking with another review before approval", async () => {
  render(<ReviewedScreenshotControl conversationId={chat} />);
  const id = await start(); await deliver(preview(id));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Left" }), { target: { value: "10" } });
  expect(screen.getByRole("button", { name: "Crop to area" })).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "40" } });
  fireEvent.click(screen.getByRole("button", { name: "Mask area" }));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "review-edit", reviewId: id, revision: 1, operation: "mask", area: { x: 10, y: 0, width: 40, height: 80 } });
  await deliver(preview(id, 2));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Height" }), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Crop to area" }));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "review-edit", reviewId: id, revision: 2, operation: "crop", area: { x: 0, y: 0, width: 100, height: 30 } });
});

it.each(["escape", "unmount", "chat-change"])("cancels the exact review on %s and ignores late pixels", async (action) => {
  const view = render(<ReviewedScreenshotControl conversationId={chat} />);
  const id = await start();
  if (action === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  else if (action === "unmount") view.unmount();
  else view.rerender(<ReviewedScreenshotControl conversationId="another-chat" />);
  await waitFor(() => expect(snapshot).toHaveBeenCalledWith({ type: "review-cancel", reviewId: id }));
  await deliver(preview(id));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps denied capture visible without asking for approval or silently retrying", async () => {
  render(<ReviewedScreenshotControl conversationId={chat} />);
  const id = await start();
  await deliver({ reviewId: id, stage: "closed", message: "Permission denied. Nothing was attached." });
  await deliver({ reviewId: id, stage: "closed" });
  expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.queryByRole("button", { name: "Attach reviewed image" })).toBeNull();
  expect(snapshot).toHaveBeenCalledTimes(1);
});

it("disables capture when the composer cannot accept images", () => {
  render(<ReviewedScreenshotControl conversationId={chat} disabled />);
  expect(screen.getByRole("button", { name: "Take reviewed screenshot" })).toBeDisabled();
});
