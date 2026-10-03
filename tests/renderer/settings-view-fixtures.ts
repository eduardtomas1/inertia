import type { ComponentProps } from "react";
import { vi } from "vitest";

import type { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings, type ProviderInfo } from "../../src/shared/contracts";

export type SettingsViewProps = ComponentProps<typeof SettingsView>;

export function settingsProvider(id: "codex" | "claude", label: string): ProviderInfo {
  const metadata = {
    freshness: "unavailable" as const,
    provenance: null,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
  return {
    id,
    label,
    command: id,
    available: true,
    version: "1.0.0",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

export function settingsViewProps(
  overrides: Partial<SettingsViewProps> = {},
): SettingsViewProps {
  return {
    settings: defaultSettings,
    disabled: false,
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    projects: [],
    conversations: [],
    archived: [],
    onUpdate: vi.fn(async () => undefined),
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
    ...overrides,
  };
}
