import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorageSettings } from "../../src/renderer/src/components/AttachmentStorageSettings";
import CanaryRollbackSetting from "../../src/renderer/src/components/CanaryRollbackSetting";
import { MascotSettings } from "../../src/renderer/src/components/MascotSettings";
import { SnapshotSettings } from "../../src/renderer/src/components/SnapshotSettings";
import { AppUpdateSettings } from "../../src/renderer/src/components/settings/AppUpdateSettings";
import { RestoreDefaults } from "../../src/renderer/src/components/settings/RestoreDefaults";
import { KeyboardSettings } from "../../src/renderer/src/components/settings/sections/KeyboardSettings";
import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";
import { emptyMascotStatus, type MascotSettingsBridge, type MascotSnapshot } from "../../src/shared/mascot";
import type { SnapshotState } from "../../src/shared/snapshots";
import { deferred } from "./composer-fixtures";

const original = window.inertia;
afterEach(() => {
  window.inertia = original;
  Reflect.deleteProperty(window, "inertiaMascot");
  vi.restoreAllMocks();
});

function expectHeldWhileBusy(control: HTMLElement): void {
  expect(control).not.toBeDisabled();
  expect(control).toHaveAttribute("aria-disabled", "true");
  expect(control).toHaveFocus();
}

function press(control: HTMLElement): void {
  control.focus();
  fireEvent.click(control);
}

describe("busy settings controls keep focus", () => {
  it("keeps Restore defaults focused and ignores repeats while it runs", async () => {
    const pending = deferred<void>();
    const onRestoreDefaults = vi.fn(() => pending.promise);
    render(<RestoreDefaults confirmDestructiveActions={false} disabled={false} onRestoreDefaults={onRestoreDefaults} />);
    const button = screen.getByRole("button", { name: "Restore defaults" });
    press(button);
    expectHeldWhileBusy(button);
    fireEvent.click(button);
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("keeps Check now focused while the update check runs", async () => {
    const pending = deferred<void>();
    const onCheckAppUpdate = vi.fn(() => pending.promise);
    render(<AppUpdateSettings appUpdateStatus={null} checkingAppUpdate={false} onCheckAppUpdate={onCheckAppUpdate}
      onDownloadAppUpdate={vi.fn()} onCancelAppUpdateDownload={vi.fn()} onInstallAppUpdate={vi.fn()} onOpenAppRelease={vi.fn()} />);
    const button = screen.getByRole("button", { name: /Check now/u });
    press(button);
    expect(button).toHaveTextContent("Checking…");
    expectHeldWhileBusy(button);
    fireEvent.click(button);
    expect(onCheckAppUpdate).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); await pending.promise; });
  });

  it("keeps the Snapshots switch and shortcut focused while the configuration saves", async () => {
    const state: SnapshotState = { enabled: false, shortcut: "accelerator", available: true, permission: "granted", message: null };
    const pending = deferred<SnapshotState>();
    const snapshot = vi.fn(async (input: { type: string }) => (input.type === "configure" ? pending.promise : state));
    window.inertia = { ...original, getPlatform: () => "darwin", snapshot };
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const view = render(<SnapshotSettings />);
    const toggle = screen.getByRole("switch", { name: "Window snapshots" });
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
    press(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
    expectHeldWhileBusy(toggle);
    await act(async () => { pending.resolve({ ...state, enabled: true }); await pending.promise; });
    view.unmount();

    const next = deferred<SnapshotState>();
    snapshot.mockImplementation(async (input: { type: string }) => (input.type === "configure" ? next.promise : state));
    render(<KeyboardSettings keybindings={DEFAULT_APP_KEYBINDINGS} disabled={false} onUpdate={vi.fn(async () => undefined)} />);
    const shortcut = await screen.findByRole("combobox", { name: "Window snapshot" });
    await waitFor(() => expect(shortcut).not.toHaveAttribute("aria-disabled"));
    shortcut.focus();
    fireEvent.change(shortcut, { target: { value: "both-shift" } });
    await waitFor(() => expect(shortcut).toHaveAttribute("aria-disabled", "true"));
    expectHeldWhileBusy(shortcut);
    await act(async () => { next.resolve({ ...state, shortcut: "both-shift" }); await next.promise; });
  });

  it("keeps the automatic removal switch and Refresh storage available to focus while storage saves", async () => {
    const storage = { state: "ready" as const, records: 70, bytes: 1024, maxBytes: 16 * 1024 ** 3, maxRecords: 65_536,
      availableDiskBytes: 1024 ** 3, removableRecords: 0, removableBytes: 0 };
    const ready: ServerEvent = { type: "request.result", requestId: "request", result: { kind: "attachment.storage", storage } };
    const request = vi.fn().mockResolvedValue(ready);
    const pending = deferred<void>();
    const onUpdate = vi.fn(() => pending.promise);
    render(<AttachmentStorageSettings settings={{ ...defaultSettings, autoRemoveOldAttachments: true }} disabled={false} request={request} onUpdate={onUpdate} />);
    const toggle = screen.getByRole("switch", { name: "Free space automatically when full" });
    press(toggle);
    expect(onUpdate).toHaveBeenCalledWith({ autoRemoveOldAttachments: false });
    expectHeldWhileBusy(toggle);
    const refresh = screen.getByRole("button", { name: "Refresh storage" });
    expect(refresh).not.toBeDisabled();
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    fireEvent.click(refresh);
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); await pending.promise; });
  });

  it("keeps the confirmed removal focused while stored files are removed", async () => {
    const storage = { state: "ready" as const, records: 70, bytes: 1024, maxBytes: 16 * 1024 ** 3, maxRecords: 65_536,
      availableDiskBytes: 1024 ** 3, removableRecords: 4, removableBytes: 512 };
    const ready: ServerEvent = { type: "request.result", requestId: "request", result: { kind: "attachment.storage", storage } };
    const cleanup = deferred<ServerEvent>();
    const request = vi.fn((command: { type: string }) => (command.type === "attachment.storage.cleanup" ? cleanup.promise : Promise.resolve(ready)));
    render(<AttachmentStorageSettings settings={defaultSettings} disabled={false} request={request} onUpdate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Remove oldest files \(4/u }));
    const confirm = screen.getByRole("button", { name: "Remove stored files" });
    press(confirm);
    expectHeldWhileBusy(confirm);
    fireEvent.click(confirm);
    expect(request.mock.calls.filter(([command]) => command.type === "attachment.storage.cleanup")).toHaveLength(1);
    await act(async () => { cleanup.resolve(ready); await cleanup.promise; });
  });

  it("keeps Prepare rollback focused while the package is prepared", async () => {
    const pending = deferred<{ state: "ready"; version: string; message: string }>();
    const prepareCanaryRollback = vi.fn(() => pending.promise);
    window.inertia = {
      ...original,
      getPlatform: () => "darwin",
      getCanaryRollbackStatus: vi.fn(async () => ({ state: "not-prepared" as const, version: null, message: "Not prepared." })),
      prepareCanaryRollback,
    };
    render(<CanaryRollbackSetting />);
    const button = await screen.findByRole("button", { name: "Prepare rollback" });
    press(button);
    expectHeldWhileBusy(button);
    fireEvent.click(button);
    expect(prepareCanaryRollback).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ state: "ready", version: "0.0.1", message: "Ready." }); await pending.promise; });
  });

  it("keeps mascot switches and sprite buttons focused while the mascot is busy", async () => {
    let snapshot: MascotSnapshot = { preferences: { enabled: false, motion: true }, status: emptyMascotStatus() };
    const configuring = deferred<void>();
    const importing = deferred<Awaited<ReturnType<MascotSettingsBridge["importSprites"]>>>();
    const bridge = {
      snapshot: vi.fn(async () => snapshot),
      onChanged: vi.fn(() => () => undefined),
      action: vi.fn(async () => undefined),
      configure: vi.fn(async (preferences: MascotSnapshot["preferences"]) => {
        await configuring.promise;
        return (snapshot = { ...snapshot, preferences });
      }),
      importSprites: vi.fn(() => importing.promise),
      applySprites: vi.fn(async () => snapshot),
      resetSprites: vi.fn(async () => snapshot),
      exportSpriteTemplate: vi.fn<MascotSettingsBridge["exportSpriteTemplate"]>(),
    } satisfies MascotSettingsBridge;
    window.inertiaMascot = bridge;
    render(<MascotSettings />);
    const importButton = await screen.findByRole("button", { name: "Import sprites" });
    press(importButton);
    expect(importButton).toHaveTextContent("Importing…");
    expectHeldWhileBusy(importButton);
    expect(screen.getByRole("button", { name: "Export template" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(importButton);
    fireEvent.click(screen.getByRole("button", { name: "Export template" }));
    expect(bridge.importSprites).toHaveBeenCalledOnce();
    expect(bridge.exportSpriteTemplate).not.toHaveBeenCalled();
    await act(async () => { importing.resolve({ status: "cancelled" }); await importing.promise; });

    const show = screen.getAllByRole("switch")[0]!;
    press(show);
    expectHeldWhileBusy(show);
    fireEvent.click(show);
    expect(bridge.configure).toHaveBeenCalledOnce();
    await act(async () => { configuring.resolve(); await configuring.promise; });
    await waitFor(() => expect(show).not.toHaveAttribute("aria-disabled"));
  });
});
