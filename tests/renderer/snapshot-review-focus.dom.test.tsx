import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SnapshotRequest } from "../../src/shared/snapshots";
import type { SnapshotReview } from "../../src/shared/snapshot-review";
import { ReviewedScreenshotControl } from "../../src/renderer/src/components/composer/ReviewedScreenshotControl";

const original = window.inertia;
const originalSetAttribute = Element.prototype.setAttribute;
const originalFocus = HTMLElement.prototype.focus;
const state = { enabled: false, shortcut: "accelerator" as const, available: false, permission: "unverified" as const, message: null };
const snapshot = vi.fn(async (_request: SnapshotRequest) => state);
const chat = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  window.inertia = { ...original, snapshot };
  snapshot.mockImplementation(async () => state);
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    if (this.hasAttribute("disabled") || this.closest("fieldset[disabled]")) return;
    originalFocus.call(this, options);
  };
  Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string) {
    const active = document.activeElement;
    if (name === "disabled" && active instanceof HTMLElement && active !== document.body && (this === active || this.contains(active))) active.blur();
    originalSetAttribute.call(this, name, value);
  };
});
afterEach(() => {
  Element.prototype.setAttribute = originalSetAttribute; HTMLElement.prototype.focus = originalFocus;
  window.inertia = original; vi.restoreAllMocks(); snapshot.mockClear();
});

const deliver = (review: SnapshotReview) => act(async () => {
  window.dispatchEvent(new CustomEvent("inertia:snapshot-review", { detail: { conversationId: chat, review } }));
});
const preview = (reviewId: string, revision = 1) => ({ stage: "image" as const, reviewId, revision, width: 100, height: 80, preview: "data:image/png;base64,fixture" });
async function start() {
  const camera = screen.getByRole("button", { name: "Take reviewed screenshot" });
  camera.focus(); fireEvent.click(camera);
  await waitFor(() => expect(snapshot).toHaveBeenCalled());
  return (snapshot.mock.calls[0] as unknown as [{ reviewId: string }])[0].reviewId;
}

it("emulates Chromium focus rules for controls that become disabled", () => {
  const { container } = render(<fieldset><button type="button">Mask</button></fieldset>);
  const button = screen.getByRole("button", { name: "Mask" }); button.focus();
  container.querySelector("fieldset")!.setAttribute("disabled", "");
  expect(document.activeElement).toBe(document.body);
  button.focus();
  expect(document.activeElement).toBe(document.body);
});

it("returns focus to Take reviewed screenshot after the dialog closes", async () => {
  render(<ReviewedScreenshotControl conversationId={chat} />);
  await start();
  expect(screen.getByRole("button", { name: "Cancel screenshot" })).toHaveFocus();
  const camera = screen.getByRole("button", { name: "Take reviewed screenshot" });
  expect(camera).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(camera);
  expect(snapshot).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Take reviewed screenshot" })).toHaveFocus();
});

it.each([["Mask area", 100], ["Crop to area", 40]])("keeps keyboard focus on %s while the edit is pending and after the edited image arrives", async (name, width) => {
  snapshot.mockImplementation(async (request) => request.type === "review-edit" ? await new Promise<never>(() => undefined) : state);
  render(<ReviewedScreenshotControl conversationId={chat} />);
  const id = await start(); await deliver(preview(id));
  const control = screen.getByRole("button", { name });
  control.focus(); fireEvent.click(control);
  expect(control).toHaveFocus();
  expect(screen.getByRole("group", { name: /Drag an area/u })).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(control);
  expect(snapshot.mock.calls.filter(([request]) => request.type === "review-edit")).toHaveLength(1);
  await deliver({ ...preview(id, 2), width });
  expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  expect(screen.getByRole("button", { name })).toHaveFocus();
});
