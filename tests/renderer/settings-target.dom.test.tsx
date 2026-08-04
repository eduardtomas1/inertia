import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings } from "../../src/shared/contracts";
import type { PrivateConnectStateView } from "../../src/shared/private-connect/protocol";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings external section targets", () => {
  it("responds to each new target while preserving ordinary local navigation", async () => {
    const state: PrivateConnectStateView = {
      available: true,
      enabled: false,
      status: "off",
      statusMessage: null,
      externalUrl: null,
      diagnostics: { tailscale: "unknown", magicDns: "unknown", gatewayPort: null, servePort: null, externalUrl: null, mappingOwnership: "unknown", errorClass: null },
      activeSessions: 0,
      devices: [],
      pendingPairings: [],
      invitation: null,
      notice: null,
    };
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getPrivateConnectState: vi.fn(async () => state),
        onPrivateConnectState: vi.fn(() => vi.fn()),
      },
    });
    const providersTarget = { section: "providers" as const };
    const props: ComponentProps<typeof SettingsView> = {
      target: providersTarget,
      settings: defaultSettings,
      disabled: false,
      providers: [],
      backendProfiles: [],
      backendDefaults: [],
      projects: [],
      conversations: [],
      archived: [],
      databaseBackup: {
        lastValidatedAt: "2026-08-03T10:15:00.000Z",
      },
      onUpdate: vi.fn(),
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
      onCopyRuntimeDiagnosticReport: vi.fn(async () => ({
        copied: true,
        eventCount: 0,
      })),
      appUpdateStatus: null,
      checkingAppUpdate: false,
      onCheckAppUpdate: vi.fn(async () => undefined),
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
    const view = render(<SettingsView {...props} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Providers",
    );

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "General",
    );
    view.rerender(<SettingsView {...props} disabled />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "General",
    );

    const connectionsTarget = { section: "connections" as const };
    view.rerender(<SettingsView {...props} target={connectionsTarget} />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Inertia Private Connect",
    );

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    view.rerender(<SettingsView {...props} target={connectionsTarget} disabled />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "General",
    );

    view.rerender(<SettingsView
      {...props}
      target={{ section: "connections" }}
    />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(
      "Inertia Private Connect",
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive & data" }));
    expect(screen.getByText("Full local database backup")).toBeVisible();
    expect(screen.getByText(/Last validated backup:/u)).toBeVisible();
    expect(screen.getByText("Portable conversation recovery export"))
      .toBeVisible();
    expect(screen.getByText(
      /exclude attachments, provider sessions, execution context, Git artifacts, credentials/u,
    )).toBeVisible();
  });
});
