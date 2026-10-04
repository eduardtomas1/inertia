import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorageSettings } from "../../src/renderer/src/components/AttachmentStorageSettings";
import CanaryRollbackSetting from "../../src/renderer/src/components/CanaryRollbackSetting";
import type { IssueReportSettingsProps } from "../../src/renderer/src/components/IssueReportSettings";
import { MascotSettings } from "../../src/renderer/src/components/MascotSettings";
import { ProjectSettings } from "../../src/renderer/src/components/ProjectSettings";
import { SnapshotSettings } from "../../src/renderer/src/components/SnapshotSettings";
import { AppUpdateSettings } from "../../src/renderer/src/components/settings/AppUpdateSettings";
import { RestoreDefaults } from "../../src/renderer/src/components/settings/RestoreDefaults";
import { ArchivedChats } from "../../src/renderer/src/components/settings/sections/ArchivedChats";
import { KeyboardSettings } from "../../src/renderer/src/components/settings/sections/KeyboardSettings";
import { defaultSettings, type Conversation, type Project, type ServerEvent } from "../../src/shared/contracts";
import { DEFAULT_APP_KEYBINDINGS } from "../../src/shared/keybindings";
import { emptyMascotStatus, type MascotSettingsBridge, type MascotSnapshot } from "../../src/shared/mascot";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { SnapshotState } from "../../src/shared/snapshots";
import { conversation, deferred, provider } from "./composer-fixtures";

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
    await act(async () => undefined);
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
    await act(async () => undefined);
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

const project: Project = { id: "11111111-1111-4111-8111-111111111111", name: "Studio", path: "/workspace/studio", normalizedPath: "/workspace/studio",
  repositoryIdentity: "git:/workspace/studio/.git", repositoryRoot: "/workspace/studio", repositoryRelativePath: "",
  groupingMode: null, gitRepositoryLimit: 16, color: "#5661d8", status: "ready", createdAt: "2026-09-09T08:00:00.000Z",
  updatedAt: "2026-09-09T08:00:00.000Z", preferences: defaultProjectPreferences() };

function renderProject(subject: Project = project) {
  const request = vi.fn<IssueReportSettingsProps["request"]>().mockResolvedValue({ type: "request.ok", requestId: "test" });
  const view = render(<ProjectSettings projects={[subject]} conversations={[]} providers={[provider]} backendDefaults={[]} backendProfiles={[]}
    settings={defaultSettings} disabled={false} request={request} onUpdateSettings={vi.fn()} initialProjectId={subject.id} />);
  return { request, view };
}

function archivedChat(id: string, title: string, archivedAt: string): Conversation {
  return { ...conversation(id), title, archivedAt };
}

describe("focus survives controls that close themselves", () => {
  it("returns focus to Choose icon after an icon is picked", async () => {
    const { request } = renderProject();
    const trigger = screen.getByRole("button", { name: "Choose icon" });
    press(trigger);
    press(screen.getAllByRole("button", { name: / icon$/u })[1]!);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Project icons" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to Add action when the action form is cancelled or saved", async () => {
    const { request } = renderProject();
    const add = screen.getByRole("button", { name: "Add action" });
    press(add);
    press(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New action" })).toBeNull();
    expect(add).toHaveFocus();
    press(add);
    fireEvent.change(within(screen.getByRole("form", { name: "New action" })).getByLabelText("Name", { exact: true }), { target: { value: "Check" } });
    fireEvent.change(screen.getByLabelText("Executable", { exact: true }), { target: { value: "node" } });
    press(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save action" })).toBeNull());
    expect(add).toHaveFocus();
  });

  it("keeps Add action focusable once the last allowed action is saved", async () => {
    const actions = Array.from({ length: 19 }, (_, index) => ({ id: `action-${index}`, name: `Action ${index}`, executable: "node", args: [] }));
    const full = { ...project, preferences: { ...defaultProjectPreferences(), actions } };
    const { request, view } = renderProject(full);
    const add = screen.getByRole("button", { name: "Add action" });
    press(add);
    fireEvent.change(within(screen.getByRole("form", { name: "New action" })).getByLabelText("Name", { exact: true }), { target: { value: "Last" } });
    fireEvent.change(screen.getByLabelText("Executable", { exact: true }), { target: { value: "node" } });
    press(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    const saved = { ...full, updatedAt: "2026-09-09T09:00:00.000Z", preferences: { ...full.preferences, actions: [...actions, { id: "last", name: "Last", executable: "node", args: [] }] } };
    view.rerender(<ProjectSettings projects={[saved]} conversations={[]} providers={[provider]} backendDefaults={[]} backendProfiles={[]}
      settings={defaultSettings} disabled={false} request={request} onUpdateSettings={vi.fn()} initialProjectId={saved.id} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save action" })).toBeNull());
    expect(add).toHaveFocus();
    expect(add).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(add);
    expect(screen.queryByRole("form", { name: "New action" })).toBeNull();
  });

  it("moves focus to the next Restore, then to the filter, when a restored chat leaves the list", () => {
    const chats = [
      archivedChat("a", "Oldest", "2026-10-01T00:00:00.000Z"),
      archivedChat("b", "Middle", "2026-10-02T00:00:00.000Z"),
      archivedChat("c", "Newest", "2026-10-03T00:00:00.000Z"),
    ];
    const onUnarchive = vi.fn();
    const view = render(<ArchivedChats archived={chats} providers={[provider]} disabled={false} onUnarchive={onUnarchive} />);
    press(screen.getByRole("button", { name: "Restore Middle" }));
    expect(onUnarchive).toHaveBeenCalledWith(chats[1]);
    view.rerender(<ArchivedChats archived={[chats[0]!, chats[2]!]} providers={[provider]} disabled={false} onUnarchive={onUnarchive} />);
    expect(screen.getByRole("button", { name: "Restore Oldest" })).toHaveFocus();
    press(screen.getByRole("button", { name: "Restore Oldest" }));
    view.rerender(<ArchivedChats archived={[chats[2]!]} providers={[provider]} disabled={false} onUnarchive={onUnarchive} />);
    expect(screen.getByRole("button", { name: "Restore Newest" })).toHaveFocus();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter archived chats" }), { target: { value: "new" } });
    press(screen.getByRole("button", { name: "Restore Newest" }));
    view.rerender(<ArchivedChats archived={[archivedChat("d", "Other", "2026-10-04T00:00:00.000Z")]} providers={[provider]} disabled={false} onUnarchive={onUnarchive} />);
    expect(screen.getByRole("searchbox", { name: "Filter archived chats" })).toHaveFocus();
  });

  it("moves focus to the empty message when the last archived chat is restored", () => {
    const chat = archivedChat("a", "Only", "2026-10-01T00:00:00.000Z");
    const view = render(<ArchivedChats archived={[chat]} providers={[provider]} disabled={false} onUnarchive={vi.fn()} />);
    press(screen.getByRole("button", { name: "Restore Only" }));
    view.rerender(<ArchivedChats archived={[]} providers={[provider]} disabled={false} onUnarchive={vi.fn()} />);
    expect(screen.getByText("No archived chats.")).toHaveFocus();
  });
});
