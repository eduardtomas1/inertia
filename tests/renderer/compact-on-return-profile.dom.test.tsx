import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import {
  backendProfileCreatePayload,
  backendProfileUpdatePayload,
} from "../../src/renderer/src/lib/backendProfileCommands";
import {
  backendEditDraftFromDetail,
  backendProfileSemanticUpdate,
} from "../../src/renderer/src/utils/backendProfileDraft";
import type {
  ModelBackendProfileDetail,
  ProviderId,
  ProviderInfo,
} from "../../src/shared/contracts";
import { backendView, probeResult } from "./backend-view-fixtures";

type Props = ComponentProps<typeof ModelBackendsSettings>;

const PROMPT_CACHE_NOTE = "A 1-hour cache costs more to write and less to resume after a break; worth it when you return to a chat after 5 to 60 minutes.";

function provider(id: ProviderId): ProviderInfo {
  const metadata = { freshness: "unavailable" as const, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false };
  return {
    id,
    label: id,
    command: id,
    available: true,
    version: "1.0.0",
    executable: `/usr/local/bin/${id}`,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

function key(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  const id = overrides.id ?? "custom:anthropic";
  const anthropic = (overrides.preset ?? "anthropic-api-key") === "anthropic-api-key";
  return backendView<ModelBackendProfileDetail>({
    id,
    displayName: anthropic ? "Anthropic API key" : "OpenAI API key",
    harnessId: anthropic ? "claude-agent-sdk" : "codex-app-server",
    protocol: anthropic ? "anthropic-messages" : "openai-responses",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: `endpoint:${id}`,
    preset: "anthropic-api-key",
    baseUrl: anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:1",
    models: [{ id: "model-a", displayName: "Model A", contextWindowTokens: null, reasoningOptions: [], capabilities: [] }],
    routing: { mode: "simple", primaryModelId: "model-a" },
    capabilityHints: [],
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    endpointHost: anthropic ? "api.anthropic.com" : "api.openai.com",
    authState: "configured",
    connectionState: "connected",
    compatibility: {
      harnessId: anthropic ? "claude-agent-sdk" : "codex-app-server",
      backendProfileId: id,
      backendProtocol: anthropic ? "anthropic-messages" : "openai-responses",
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
  } as Parameters<typeof backendView<ModelBackendProfileDetail>>[0]);
}

function probed(profile: ModelBackendProfileDetail): ModelBackendProfileDetail {
  return {
    ...profile,
    models: profile.models.map((model) => ({
      ...model,
      latestProbe: probeResult(profile.id, model.id, null, profile.configurationRevision),
    })),
  };
}

function props(profile: ModelBackendProfileDetail, overrides: Partial<Props> = {}): Props {
  return {
    profiles: [profile],
    providers: [provider("claude"), provider("codex")],
    disabled: false,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    onLoadDetail: vi.fn(async () => profile),
    onCreate: vi.fn(async () => profile),
    onUpdate: vi.fn(async () => profile),
    onSetCredential: vi.fn(async () => profile),
    onClearCredential: vi.fn(async () => profile),
    onProbe: vi.fn(async () => probed(profile)),
    onDiscoverModels: vi.fn(async () => []),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Prompt cache option", () => {
  it("shows the prompt cache length on the Anthropic key row", () => {
    const { rerender } = render(<ModelBackendsSettings {...props(key())} />);
    const row = screen.getByRole("listitem", { name: "Anthropic API key" });
    expect(within(row).getByText(/5-minute prompt cache/u)).toBeInTheDocument();

    rerender(<ModelBackendsSettings {...props(key({ promptCacheTtl: "1h" }))} />);
    expect(within(screen.getByRole("listitem", { name: "Anthropic API key" })).getByText(/1-hour prompt cache/u))
      .toBeInTheDocument();
  });

  it("chooses a 1-hour cache in the route editor and saves it without retesting the models", async () => {
    const user = userEvent.setup();
    const profile = key();
    const onUpdate = vi.fn(async () => ({ ...profile, promptCacheTtl: "1h" as const }));
    const onProbe = vi.fn(async () => probed(profile));
    render(<ModelBackendsSettings {...props(profile, { onUpdate, onProbe })} />);
    await user.click(screen.getByRole("button", { name: "Models for Anthropic API key" }));
    const form = await screen.findByRole("form", { name: "Edit Anthropic API key" });

    const cache = within(form).getByRole("group", { name: "Prompt cache" });
    expect(within(cache).getByRole("radio", { name: "5 minutes (default)" })).toBeChecked();
    expect(within(cache).getByText(PROMPT_CACHE_NOTE)).toBeInTheDocument();
    await user.click(within(cache).getByRole("radio", { name: "1 hour" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("custom:anthropic", { promptCacheTtl: "1h" }));
    expect(onProbe).not.toHaveBeenCalled();
  });

  it("offers no prompt cache choice on an OpenAI key", async () => {
    const user = userEvent.setup();
    const profile = key({ id: "custom:openai", preset: "openai-api-key" });
    render(<ModelBackendsSettings {...props(profile)} />);
    expect(within(screen.getByRole("listitem", { name: "OpenAI API key" })).queryByText(/prompt cache/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Models for OpenAI API key" }));
    const form = await screen.findByRole("form", { name: "Edit OpenAI API key" });
    expect(within(form).queryByRole("group", { name: "Prompt cache" })).toBeNull();
  });

  it("sends a 1-hour cache when adding an Anthropic key and leaves the default out", async () => {
    const user = userEvent.setup();
    const created = key({ id: "custom:new", enabled: false, authState: "missing", connectionState: "not-tested" });
    const onCreate = vi.fn(async () => created);
    render(<ModelBackendsSettings {...props(key(), {
      profiles: [],
      onCreate,
      onSetCredential: vi.fn(async () => ({ ...created, authState: "configured" as const })),
      onProbe: vi.fn(async () => ({ ...created, authState: "configured" as const, connectionState: "connected" as const })),
      onUpdate: vi.fn(async () => ({ ...created, enabled: true, authState: "configured" as const })),
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog", { name: "Add Anthropic API key" });
    const cache = within(dialog).getByRole("group", { name: "Prompt cache" });
    expect(within(cache).getByRole("radio", { name: "5 minutes (default)" })).toBeChecked();
    expect(within(cache).getByText(PROMPT_CACHE_NOTE)).toBeInTheDocument();
    await user.click(within(cache).getByRole("radio", { name: "1 hour" }));
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant-test-key{Enter}");

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      preset: "anthropic-api-key",
      displayName: "Anthropic API key",
      promptCacheTtl: "1h",
    }));
  });
});

describe("Prompt cache payloads", () => {
  it("carries the prompt cache length through the edit draft, update and create payloads", () => {
    const original = backendEditDraftFromDetail(key());
    expect(original.promptCacheTtl).toBe("5m");
    expect(backendProfileSemanticUpdate(original, { ...original, promptCacheTtl: "1h" })).toEqual({ promptCacheTtl: "1h" });
    expect(backendProfileUpdatePayload({ promptCacheTtl: "1h" })).toEqual({ promptCacheTtl: "1h" });
    expect(backendProfileCreatePayload({ preset: "anthropic-api-key", displayName: "Key", promptCacheTtl: "1h" }))
      .toEqual({ preset: "anthropic-api-key", displayName: "Key", promptCacheTtl: "1h" });
    expect(backendEditDraftFromDetail(key({ id: "custom:openai", preset: "openai-api-key" })).promptCacheTtl).toBeUndefined();
  });
});
