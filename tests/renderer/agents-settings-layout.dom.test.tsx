import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import type { ModelBackendProfileDetail } from "../../src/shared/contracts";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

function profile(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  return {
    id: "custom:a",
    displayName: "Profile A",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: "endpoint:custom:a:1",
    preset: "custom",
    baseUrl: "https://custom-a.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{ id: "custom-a-model", displayName: "Profile A model", contextWindowTokens: 128_000, reasoningOptions: [], capabilities: [] }],
    routing: { mode: "simple", primaryModelId: "custom-a-model" },
    capabilityHints: [{ id: "streaming", state: "verified", provenance: "provider", detail: null }],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    endpointHost: "custom-a.example.test",
    authState: "configured",
    connectionState: "connected",
    compatibility: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:a",
      backendProtocol: "anthropic-messages",
      state: "verified",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "anthropic-probe-verified",
      reason: "The endpoint passed the compatibility probe.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  };
}

function backendProps(
  overrides: Partial<ComponentProps<typeof ModelBackendsSettings>> = {},
): ComponentProps<typeof ModelBackendsSettings> {
  const ready = profile();
  const missing = profile({ id: "custom:b", displayName: "Profile B", endpointHost: "custom-b.example.test", authState: "missing" });
  return {
    profiles: [ready, missing],
    disabled: false,
    onLoadDetail: vi.fn(async (id: string) => (id === missing.id ? missing : ready)),
    onCreate: vi.fn(async () => ready),
    onUpdate: vi.fn(async () => ready),
    onSetCredential: vi.fn(async () => ready),
    onClearCredential: vi.fn(async () => ready),
    onProbe: vi.fn(async () => ready),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { getPlatform: () => "darwin", getAppHealth: vi.fn(async () => null) },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Agents providers layout", () => {
  it("shows each provider status once per place as icon, word and version, without pills", async () => {
    const claude = { ...settingsProvider("claude", "Claude"), authState: "unauthenticated" as const, canRun: false, statusMessage: "Sign in required" };
    const { container } = render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [settingsProvider("codex", "Codex"), claude],
    })} />);
    const codex = await screen.findByRole("button", { name: "Configure Codex" });
    expect(codex).toHaveAccessibleDescription(/Connected/u);
    expect(within(codex).getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure Claude" })).toHaveAccessibleDescription(/Sign in required/u);
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.getAllByText("v1.0.0")).toHaveLength(3);
    expect(container.querySelector(".provider-status")).toBeNull();
    for (const text of ["Account status", "Local provider status", "Capability contract"]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Configure Claude" }));
    expect(screen.getAllByText("Sign in required")).toHaveLength(2);
  });

  it("keeps provider actions focusable while Settings is unavailable and ignores their clicks", async () => {
    const onRefreshProvider = vi.fn();
    const onChooseCodexBinary = vi.fn();
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      disabled: true,
      providers: [settingsProvider("codex", "Codex")],
      onRefreshProvider,
      onChooseCodexBinary,
    })} />);
    for (const name of ["Refresh all providers", "Refresh", "Browse"]) {
      const button = await screen.findByRole("button", { name, exact: true });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
    }
    expect(onRefreshProvider).not.toHaveBeenCalled();
    expect(onChooseCodexBinary).not.toHaveBeenCalled();
  });
});

describe("Agents custom backends layout", () => {
  it("names each profile's state in words instead of a coloured dot", async () => {
    const { container } = render(<ModelBackendsSettings {...backendProps()} />);
    const rail = screen.getByRole("complementary", { name: "Backend profiles" });
    expect(within(within(rail).getByTitle("Claude harness · Profile A")).getByText("Ready")).toBeInTheDocument();
    expect(within(within(rail).getByTitle("Claude harness · Profile B")).getByText("Needs credential")).toBeInTheDocument();
    expect(container.querySelector(".backend-profile-dot")).toBeNull();
    expect(await screen.findByRole("switch", { name: "Use this backend" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    const details = screen.getByText("Details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByRole("list", { name: "Profile A capabilities" })).toHaveTextContent("Streaming");
    expect(within(details).getByRole("list", { name: "Profile A capabilities" })).toHaveTextContent("Verified · from the provider");
  });

  it("keeps Test connection focused and inert while its probe runs", async () => {
    let finish!: (value: ModelBackendProfileDetail) => void;
    const onProbe = vi.fn(() => new Promise<ModelBackendProfileDetail>((resolve) => { finish = resolve; }));
    render(<ModelBackendsSettings {...backendProps({ onProbe })} />);
    const probe = await screen.findByRole("button", { name: "Test connection" });
    probe.focus();
    fireEvent.click(probe);
    const testing = screen.getByRole("button", { name: "Testing…" });
    expect(testing).toBe(probe);
    expect(testing).toHaveFocus();
    expect(testing).toHaveAttribute("aria-disabled", "true");
    expect(testing).not.toBeDisabled();
    fireEvent.click(testing);
    expect(onProbe).toHaveBeenCalledOnce();
    await act(async () => finish(profile()));
    expect(screen.getByRole("button", { name: "Test connection" })).not.toHaveAttribute("aria-disabled");
  });

  it("keeps Delete permanently focusable and inert while the deletion runs", async () => {
    let finish!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ModelBackendsSettings {...backendProps({ onDelete })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete permanently" });
    confirm.focus();
    fireEvent.click(confirm);
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledOnce();
    await act(async () => finish());
  });
});
