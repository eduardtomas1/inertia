import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  BackgroundNotificationSetting,
  QuotaWarningSettings,
} from "../../src/renderer/src/components/settings/NotificationPreferenceRows";
import { NotificationsSettings } from "../../src/renderer/src/components/settings/sections/NotificationsSettings";
import { defaultSettings } from "../../src/shared/contracts";

function row(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

describe("background-only notifications row", () => {
  it("saves the choice and shows Saved", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const { container } = render(<BackgroundNotificationSetting settings={{ desktopNotifications: true, notifyOnlyInBackground: false }} disabled={false} onUpdate={onUpdate} />);
    const control = screen.getByRole("switch", { name: "Only when Inertia is in the background" });
    expect(control).not.toHaveAttribute("aria-disabled");
    await act(async () => { fireEvent.click(control); });
    expect(onUpdate).toHaveBeenCalledWith({ notifyOnlyInBackground: true });
    expect(within(row(container, "notify-only-in-background")).getByRole("status")).toHaveTextContent("Saved");
  });

  it("is unavailable but focusable while desktop notifications are off", () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<BackgroundNotificationSetting settings={{ desktopNotifications: false, notifyOnlyInBackground: true }} disabled={false} onUpdate={onUpdate} />);
    const control = screen.getByRole("switch", { name: "Only when Inertia is in the background" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).toBeChecked();
    control.focus();
    expect(control).toHaveFocus();
    fireEvent.click(control);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("quota warning rows", () => {
  it("turns warnings off and on, keeping the chosen threshold", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const { container } = render(<QuotaWarningSettings warnings={{ enabled: true, firstThreshold: 15 }} disabled={false} onUpdate={onUpdate} />);
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Quota warnings" })); });
    expect(onUpdate).toHaveBeenCalledWith({ quotaWarnings: { enabled: false } });
    expect(within(row(container, "quota-warnings")).getByRole("status")).toHaveTextContent("Saved");
  });

  it("offers the three fixed levels and saves the first one to warn at", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const { container } = render(<QuotaWarningSettings warnings={{ enabled: true, firstThreshold: 25 }} disabled={false} onUpdate={onUpdate} />);
    const select = screen.getByRole("combobox", { name: "Warn when below" });
    expect(select).toHaveValue("25");
    expect(within(select).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["25% remaining", "15% remaining", "5% remaining"]);
    await act(async () => { fireEvent.change(select, { target: { value: "5" } }); });
    expect(onUpdate).toHaveBeenCalledWith({ quotaWarnings: { firstThreshold: 5 } });
    expect(within(row(container, "quota-warning-threshold")).getByRole("status")).toHaveTextContent("Saved");
  });

  it("says what each notification row does", () => {
    const { container } = render(<>
      <BackgroundNotificationSetting settings={{ desktopNotifications: true, notifyOnlyInBackground: false }} disabled={false} onUpdate={vi.fn(async () => undefined)} />
      <QuotaWarningSettings warnings={{ enabled: true, firstThreshold: 25 }} disabled={false} onUpdate={vi.fn(async () => undefined)} />
    </>);
    const row = (id: string) => container.querySelector(`[data-setting-id="${id}"]`);
    expect(row("notify-only-in-background")).toHaveTextContent("Skips desktop notifications while an Inertia window is in front.");
    expect(row("quota-warnings")).toHaveTextContent("Shows a notice in Inertia when an account's remaining quota drops below the chosen level.");
    expect(row("quota-warning-threshold")).toHaveTextContent("The first notice appears at this level and again at each lower one.");
  });

  it("keeps a threshold chosen just before warnings are turned off", () => {
    const onUpdate = vi.fn(() => new Promise<void>(() => undefined));
    render(<QuotaWarningSettings warnings={{ enabled: true, firstThreshold: 25 }} disabled={false} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Warn when below" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch", { name: "Quota warnings" }));
    expect(onUpdate.mock.calls).toEqual([
      [{ quotaWarnings: { firstThreshold: 5 } }],
      [{ quotaWarnings: { enabled: false } }],
    ]);
  });

  it("keeps the threshold focusable but unavailable while warnings are off", () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<QuotaWarningSettings warnings={{ enabled: false, firstThreshold: 15 }} disabled={false} onUpdate={onUpdate} />);
    const select = screen.getByRole("combobox", { name: "Warn when below" });
    expect(select).toHaveAttribute("aria-disabled", "true");
    expect(select).not.toBeDisabled();
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.change(select, { target: { value: "5" } });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(select).toHaveValue("15");
  });

  it("reports a failed save in the row", async () => {
    const onUpdate = vi.fn(async () => { throw new Error("offline"); });
    const { container } = render(<QuotaWarningSettings warnings={{ enabled: true, firstThreshold: 25 }} disabled={false} onUpdate={onUpdate} />);
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Quota warnings" })); });
    expect(within(row(container, "quota-warnings")).getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(screen.getByRole("switch", { name: "Quota warnings" })).toBeChecked();
  });
});

describe("notifications section", () => {
  it("places the background-only row under desktop notifications and the quota rows in Alerts", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const { container, rerender } = render(<NotificationsSettings settings={defaultSettings} disabled={false} onUpdate={onUpdate} />);
    const ids = [...container.querySelectorAll("[data-setting-id]")].map((element) => element.getAttribute("data-setting-id"));
    expect(ids.indexOf("notify-only-in-background")).toBe(ids.indexOf("desktop-notifications") + 1);
    expect(screen.queryByRole("heading", { name: "Quota warnings" })).toBeNull();
    const alerts = screen.getByRole("region", { name: "Alerts" });
    expect(within(alerts).getByRole("switch", { name: "Quota warnings" })).toBeChecked();
    expect(within(alerts).getByRole("combobox", { name: "Warn when below" })).toHaveValue("25");
    expect(screen.getByRole("switch", { name: "Only when Inertia is in the background" })).not.toHaveAttribute("aria-disabled");

    rerender(<NotificationsSettings settings={{ ...defaultSettings, desktopNotifications: false, quotaWarnings: { enabled: false, firstThreshold: 5 } }} disabled={false} onUpdate={onUpdate} />);
    expect(screen.getByRole("switch", { name: "Only when Inertia is in the background" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("combobox", { name: "Warn when below" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("combobox", { name: "Warn when below" })).toHaveValue("5");
    await act(async () => {});
  });
});
