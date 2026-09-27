import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings, type AppSettings } from "../../src/shared/contracts";

function settingsProps(
  settings: AppSettings,
  onUpdate: ComponentProps<typeof SettingsView>["onUpdate"],
): ComponentProps<typeof SettingsView> {
  return {
    settings,
    disabled: false,
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    projects: [],
    conversations: [],
    archived: [],
    onUpdate,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    maintenanceOperations: new Map(),
    maintenanceStatuses: new Map(),
    onRefreshProviderMaintenance: vi.fn(async () => undefined),
    onUpdateProvider: vi.fn(async () => undefined),
    onCancelProviderUpdate: vi.fn(async () => undefined),
    onOpenProviderUpdateInstructions: vi.fn(),
    onChooseCodexBinary: vi.fn(),
    onRevealRuntimeLogs: vi.fn(async () => ""),
    onCopyRuntimeDiagnosticReport: vi.fn(async () => ({ copied: true, eventCount: 0 })),
    appUpdateStatus: null,
    checkingAppUpdate: false,
    onCheckAppUpdate: vi.fn(async () => undefined),
    onDownloadAppUpdate: vi.fn(async () => undefined),
    onCancelAppUpdateDownload: vi.fn(async () => undefined),
    onInstallAppUpdate: vi.fn(async () => undefined),
    onOpenAppRelease: vi.fn(async () => undefined),
    onUnarchive: vi.fn(),
    onLoadBackendProfile: vi.fn(),
    onCreateBackendProfile: vi.fn(),
    onUpdateBackendProfile: vi.fn(),
    onSetBackendCredential: vi.fn(),
    onClearBackendCredential: vi.fn(),
    onProbeBackendProfile: vi.fn(),
    onDeleteBackendProfile: vi.fn(async () => undefined),
    onSetBackendDefault: vi.fn(async () => undefined),
    onClearBackendDefault: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin" },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
  vi.unstubAllGlobals();
});

describe("General settings controls", () => {
  it.each([
    ["Interface scale", "Default", "Comfortable", "Compact", { interfaceScale: "comfortable" }],
    ["Logical project grouping", "Keep separate", "Repository", "Repo + folder", { projectGrouping: "repository" }],
    ["Usage and context display", "Compact", "Hidden", "Expanded", { usageDisplayMode: "hidden" }],
    ["Response density", "Default", "Comfortable", "Compact", { responseDensity: "comfortable" }],
  ] as const)("moves the %s choice with arrow keys and a single tab stop", (group, checked, next, previous, update) => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsProps(defaultSettings, onUpdate)} />);
    const radios = within(screen.getByRole("radiogroup", { name: group }));
    const current = radios.getByRole("radio", { name: checked });

    expect(current).toHaveAttribute("aria-checked", "true");
    expect(radios.getAllByRole("radio").filter((radio) => radio.tabIndex === 0))
      .toEqual([current]);

    current.focus();
    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(radios.getByRole("radio", { name: next })).toHaveFocus();
    expect(onUpdate).toHaveBeenLastCalledWith(update);

    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(radios.getByRole("radio", { name: previous })).toHaveFocus();
  });

  it("asks before restoring every setting to its default", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsProps(defaultSettings, onUpdate)} />);

    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(onUpdate).toHaveBeenCalledWith(defaultSettings);
  });

  it("restores defaults without asking when destructive confirmations are off", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsProps(
      { ...defaultSettings, confirmDestructiveActions: false },
      onUpdate,
    )} />);

    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith(defaultSettings);
  });
});
