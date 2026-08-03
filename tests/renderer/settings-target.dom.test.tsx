import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings } from "../../src/shared/contracts";
import type { RemoteAccessState } from "../../src/shared/remote-protocol";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings external section targets", () => {
  it("responds to each new target while preserving ordinary local navigation", async () => {
    const state: RemoteAccessState = {
      available: true,
      enabled: false,
      relayUrl: "wss://relay.example/remote",
      setupMode: "self-hosted",
      companionUrl: "https://companion.example/",
      diagnostics: {
        status: "untested", testedAt: null, transport: null, tls: null,
        originPolicy: "unknown", relayVersion: null, browserVersion: null,
        desktopVersion: "0.2.0", relayProtocol: null, remoteProtocol: null,
        endpointAuthentication: null, persistence: null,
        endpointOwnership: "unclaimed", endpointEpoch: null, lastConnectedAt: null,
        retryClass: "none", failureClass: "none", message: null,
      },
      connection: "offline",
      connectionMessage: null,
      activeSessions: 0,
      devices: [],
      pendingPairings: [],
      invitation: null,
      audit: [],
    };
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: vi.fn(async () => state),
        onRemoteAccessState: vi.fn(() => vi.fn()),
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

    const remoteTarget = { section: "remote" as const };
    view.rerender(<SettingsView {...props} target={remoteTarget} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Remote Companion",
    );

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    view.rerender(<SettingsView {...props} target={remoteTarget} disabled />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "General",
    );

    view.rerender(<SettingsView
      {...props}
      target={{ section: "remote" }}
    />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Remote Companion",
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
