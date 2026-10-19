import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AppControlSettingsState } from "../../src/shared/app-control-settings";
import { AppControlSettings } from "../../src/renderer/src/components/AppControlSettings";

const original = window.inertia;
const mac: AppControlSettingsState = {
  platform: "darwin", available: true, accessibility: "required", screenRecording: "required", screenshots: "available", session: null,
  input: "required",
};
afterEach(() => { window.inertia = original; vi.restoreAllMocks(); });

function install(appControl: ReturnType<typeof vi.fn>): void {
  window.inertia = { ...original, appControl } as typeof window.inertia;
}

it("explains what the agent may reach and opens macOS settings only on an explicit click", async () => {
  const appControl = vi.fn().mockResolvedValue(mac);
  install(appControl);
  render(<AppControlSettings />);
  expect(screen.getByRole("region", { name: "App control" })).toHaveTextContent(/inspect and drive the native windows of apps launched from a chat's App surface/u);
  expect(screen.getByRole("region", { name: "App control" })).toHaveTextContent("Agent app access");
  expect(await screen.findByText(/Allow Inertia in System Settings → Privacy & Security → Accessibility/u)).toBeVisible();
  expect(screen.getByRole("region", { name: "App control" })).toHaveTextContent(/keyboard and wheel input only to a launched window you let it bring to the front/u);
  expect(screen.getByText("Keyboard and mouse input")).toBeVisible();
  expect(screen.getByText(/Needs Accessibility: allow Inertia/u)).toBeVisible();
  // Reading the state never opens anything.
  expect(appControl).toHaveBeenCalledTimes(1);
  expect(appControl).toHaveBeenCalledWith({ type: "state" });
  const accessibility = screen.getByRole("button", { name: "Accessibility settings" });
  accessibility.focus();
  expect(accessibility).toHaveFocus();
  fireEvent.click(accessibility);
  await waitFor(() => expect(appControl).toHaveBeenLastCalledWith({ type: "open-settings", pane: "accessibility" }));
  fireEvent.click(screen.getByRole("button", { name: "Screen Recording settings" }));
  await waitFor(() => expect(appControl).toHaveBeenLastCalledWith({ type: "open-settings", pane: "screen-recording" }));
});

it("refreshes on focus and words a helper denial and a granted Mac", async () => {
  const appControl = vi.fn()
    .mockResolvedValueOnce({ ...mac, accessibility: "helper-denied", screenRecording: "granted" })
    .mockResolvedValueOnce({ ...mac, accessibility: "granted", screenRecording: "granted", input: "available" });
  install(appControl);
  render(<AppControlSettings />);
  expect(await screen.findByText(/denied access to its App control helper/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "Accessibility settings" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Screen Recording settings" })).not.toBeInTheDocument();
  await act(async () => { fireEvent.focus(window); });
  expect(await screen.findByText(/macOS allows Inertia to read and control/u)).toBeVisible();
  expect(screen.getByText(/only after you approve bringing it to the front/u)).toBeVisible();
  expect(screen.queryByRole("button", { name: /settings$/u })).not.toBeInTheDocument();
});

it.each([
  [{ platform: "win32", accessibility: "available", screenRecording: "not-needed", session: null, input: "available" }, /runs as administrator/u, /can include windows overlapping it/u, /^Available\. Keys other than Enter and Space/u],
  [{ platform: "linux", accessibility: "available", screenRecording: "not-needed", session: "x11", input: "available" }, /AT-SPI is available/u, /can include windows overlapping it/u, /^Available\. Keys other than Enter and Space/u],
  [{ platform: "linux", accessibility: "unavailable", screenRecording: "not-needed", session: "x11", input: "unavailable" }, /AT-SPI accessibility bus did not answer/u, /can include windows overlapping it/u, /^Unavailable on this desktop/u],
  [{ platform: "linux", accessibility: "available", screenRecording: "not-needed", screenshots: "unavailable", session: "wayland", input: "unavailable" }, /AT-SPI is available/u, /Unavailable on Wayland: the desktop does not let Inertia read window pixels/u, /Unavailable on Wayland: the desktop does not let Inertia send keys/u],
] as const)("shows the %o state without any settings button", async (overrides, access, screenshots, input) => {
  install(vi.fn().mockResolvedValue({ ...mac, ...overrides }));
  render(<AppControlSettings />);
  expect(await screen.findByText(access)).toBeVisible();
  expect(screen.getByText(screenshots)).toBeVisible();
  expect(screen.getByText(input)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("says when App control is off until restart, and rejects a malformed state", async () => {
  install(vi.fn().mockResolvedValueOnce({ ...mac, available: false }).mockResolvedValueOnce({ ...mac, accessibility: "everything" }));
  render(<AppControlSettings />);
  expect(await screen.findByText(/off until Inertia restarts/u)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await act(async () => { fireEvent.focus(window); });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not read App control access");
});

it("names the desktop requirement outside the desktop app", () => {
  window.inertia = { ...original, appControl: undefined } as unknown as typeof window.inertia;
  render(<AppControlSettings />);
  expect(screen.getByRole("status")).toHaveTextContent("App control is available in the desktop app.");
});
