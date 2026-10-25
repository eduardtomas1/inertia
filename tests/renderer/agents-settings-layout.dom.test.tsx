import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import type { ModelBackendProfileDetail } from "../../src/shared/contracts";
import { backendView } from "./backend-view-fixtures";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

function profile(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  return backendView<ModelBackendProfileDetail>({
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
  });
}

function stackedRule(path: string, query: string, selector: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  const block = source.indexOf(`@container ${query} (max-width: 760px) {`);
  expect(block).toBeGreaterThanOrEqual(0);
  const start = source.indexOf(`  ${selector} {`, block);
  expect(start).toBeGreaterThan(block);
  expect(start).toBeLessThan(source.indexOf(`@container ${query} (max-width: 520px)`, block));
  return source.slice(start, source.indexOf("}", start));
}

function backendProps(
  overrides: Partial<ComponentProps<typeof ModelBackendsSettings>> = {},
): ComponentProps<typeof ModelBackendsSettings> {
  const ready = profile();
  const missing = profile({ id: "custom:b", displayName: "Profile B", endpointHost: "custom-b.example.test", authState: "missing" });
  return {
    profiles: [ready, missing],
    providers: [settingsProvider("claude", "Claude")],
    disabled: false,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    onDiscoverModels: vi.fn(async () => []),
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
  it("shows recovery guidance for Claude while keeping Codex controls usable", async () => {
    const claude = {
      ...settingsProvider("claude", "Claude"), available: false, canRun: false,
      installState: "recovery-required" as const, authState: "unknown" as const,
      version: null, executable: null,
      statusMessage: "Provider update recovery requires attention. Restart Inertia to retry recovery.",
    };
    render(<SettingsView {...settingsViewProps({
      target: { section: "agents" },
      providers: [settingsProvider("codex", "Codex"), claude],
    })} />);
    const chooseClaude = await screen.findByRole("button", { name: "Configure Claude" });
    expect(chooseClaude).toHaveAccessibleDescription("Recovery required");
    fireEvent.click(chooseClaude);
    expect(screen.getByText(claude.statusMessage)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Claude executable path" }))
      .toHaveAttribute("placeholder", "Executable check paused for recovery");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByText("Checking")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure Codex" }));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Browse" })).toBeEnabled();
  });
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
      const button = await screen.findByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
    }
    expect(onRefreshProvider).not.toHaveBeenCalled();
    expect(onChooseCodexBinary).not.toHaveBeenCalled();
  });
});

describe("Agents empty lists", () => {
  it("leaves an empty stacked list without a border of its own under the frame's top edge", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "agents" }, providers: [] })} />);
    expect(await screen.findByRole("group", { name: "Provider accounts" })).toBeEmptyDOMElement();
    expect(stackedRule("../../src/renderer/src/components/settings/ProvidersSettings.css", "providers", ".provider-settings-rail:empty"))
      .toContain("border-bottom: 0");
    const codex = await screen.findByRole("region", { name: "Codex" });
    expect(within(codex).queryByRole("list")).toBeNull();
    expect(within(codex).getByText("No API keys yet. Add an OpenAI API key to use your API credits.")).toBeVisible();
  });
});

describe("Agents accounts and API keys layout", () => {
  it("names each key route's state in words instead of a coloured dot", () => {
    const { container } = render(<ModelBackendsSettings {...backendProps()} />);
    const claude = screen.getByRole("region", { name: "Claude Code" });
    expect(within(within(claude).getByRole("listitem", { name: "Profile A" })).getByText("Ready")).toBeInTheDocument();
    expect(within(within(claude).getByRole("listitem", { name: "Profile B" })).getByText("Needs a key")).toBeInTheDocument();
    expect(container.querySelector(".backend-profile-dot")).toBeNull();
    expect(within(claude).getByRole("listitem", { name: "Profile A" })).toHaveTextContent("Custom · custom-a.example.test");
  });
});
