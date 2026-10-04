import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SnapshotState } from "../../src/shared/snapshots";
import { SnapshotSettings } from "../../src/renderer/src/components/SnapshotSettings";

const original = window.inertia;
const disabled: SnapshotState = { enabled: false, shortcut: "accelerator", available: true, permission: "unverified", message: null };
afterEach(() => { window.inertia = original; vi.restoreAllMocks(); });

it("keeps the configuration result when an older focus refresh resolves later", async () => {
  let refresh!: (state: SnapshotState) => void;
  const snapshot = vi.fn().mockResolvedValueOnce(disabled)
    .mockImplementationOnce(() => new Promise<SnapshotState>((resolve) => { refresh = resolve; }))
    .mockResolvedValueOnce({ ...disabled, enabled: true });
  window.inertia = { ...original, snapshot };
  render(<SnapshotSettings />);
  const toggle = screen.getByRole("switch", { name: "Window snapshots" });
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  fireEvent.focus(window);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(snapshot).toHaveBeenLastCalledWith({ type: "configure", enabled: true, shortcut: "accelerator" });
  await act(async () => refresh(disabled));
  expect(toggle).toBeChecked();
});

it("configures with the loaded state when the switch is used as soon as it becomes active", async () => {
  const snapshot = vi.fn().mockResolvedValueOnce(disabled).mockResolvedValueOnce({ ...disabled, enabled: true });
  window.inertia = { ...original, snapshot };
  render(<SnapshotSettings />);
  const toggle = screen.getByRole("switch", { name: "Window snapshots" });
  const clicked = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (toggle.hasAttribute("aria-disabled")) return;
      observer.disconnect();
      fireEvent.click(toggle);
      resolve();
    });
    observer.observe(toggle, { attributes: true });
  });
  await clicked;
  await waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
  expect(snapshot).toHaveBeenLastCalledWith({ type: "configure", enabled: true, shortcut: "accelerator" });
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  expect(toggle).toBeChecked();
});

it("shows the disabled authoritative state after shortcut registration fails", async () => {
  const snapshot = vi.fn().mockResolvedValueOnce({ ...disabled, enabled: true })
    .mockRejectedValueOnce(new Error("Shortcut is already registered."))
    .mockResolvedValueOnce(disabled);
  window.inertia = { ...original, snapshot };
  render(<SnapshotSettings />);
  const toggle = screen.getByRole("switch", { name: "Window snapshots" });
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent("Shortcut is already registered.");
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(toggle).not.toHaveAttribute("aria-disabled");
  expect(snapshot).toHaveBeenLastCalledWith({ type: "state" });
});

it("refreshes permission status when returning from macOS Settings", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const required: SnapshotState = { ...disabled, permission: "required" };
  const snapshot = vi.fn().mockResolvedValueOnce(required).mockResolvedValueOnce(required)
    .mockResolvedValueOnce({ ...disabled, permission: "granted" });
  window.inertia = { ...original, snapshot };
  render(<SnapshotSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Accessibility settings" }));
  await waitFor(() => expect(snapshot).toHaveBeenCalledWith({ type: "permission", permission: "accessibility" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Accessibility settings" })).toBeEnabled());
  fireEvent.focus(window);
  expect(await screen.findByText("macOS capture permissions are granted.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Accessibility settings" })).toBeNull();
});
