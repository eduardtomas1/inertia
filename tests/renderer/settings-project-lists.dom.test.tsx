import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings, type Project } from "../../src/shared/contracts";

const user = {
  id: "22222222-2222-4222-8222-222222222222", name: "Studio", path: "/studio",
  normalizedPath: "/studio", repositoryIdentity: null, repositoryRoot: null,
  repositoryRelativePath: ".", groupingMode: null, gitRepositoryLimit: 16,
  color: "#6f76d9", status: "ready", createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
} satisfies Project;
const scratch: Project = { ...user, id: "33333333-3333-4333-8333-333333333333", name: "No project", path: "/data/scratch", workspaceKind: "scratch" };

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

function props(target: ComponentProps<typeof SettingsView>["target"]): ComponentProps<typeof SettingsView> {
  return {
    target,
    settings: defaultSettings,
    disabled: false,
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    projects: [user, scratch],
    conversations: [],
    archived: [],
    databaseBackup: { lastValidatedAt: "2026-08-03T10:15:00.000Z" },
    onUpdate: vi.fn(async () => undefined),
    onSetDefaultModel: vi.fn(async () => undefined),
    onRestoreDefaults: vi.fn(async () => undefined),
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
    onReportCommand: vi.fn(async () => { throw new Error("Not used."); }),
  };
}

function optionLabels(select: HTMLElement): string[] {
  return within(select).getAllByRole("option").map(({ textContent }) => textContent ?? "");
}

describe("settings project lists", () => {
  it("keeps the folder for chats without a project out of the issue report scope", async () => {
    Object.defineProperty(window, "inertia", { configurable: true, value: { getPlatform: () => "darwin" } });
    render(<SettingsView {...props({ section: "help" })} />);
    const scope = await screen.findByRole("combobox", { name: "Diagnostic scope" });
    expect(optionLabels(scope)).toEqual(["App only", "Studio · counts only"]);
  });

  it("keeps the folder for chats without a project out of the project chooser", async () => {
    Object.defineProperty(window, "inertia", { configurable: true, value: { getPlatform: () => "darwin" } });
    render(<SettingsView {...props({ section: "projects" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose project" }));
    const dialog = screen.getByRole("dialog", { name: "Choose project" });
    expect(within(dialog).getByText("Studio")).toBeInTheDocument();
    expect(within(dialog).queryByText("No project")).toBeNull();
  });
});
