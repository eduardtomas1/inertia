import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import type {
  ModelBackendProfileDetail,
  ProviderId,
  ProviderInfo,
} from "../../src/shared/contracts";
import { backendView, probeResult } from "./backend-view-fixtures";

type Props = ComponentProps<typeof ModelBackendsSettings>;

function provider(id: ProviderId, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  const metadata = {
    freshness: "unavailable" as const,
    provenance: null,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
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
    ...overrides,
  };
}

const verified = (profileId: string) => ({
  harnessId: "claude-agent-sdk" as const,
  backendProfileId: profileId,
  backendProtocol: "anthropic-messages" as const,
  state: "verified" as const,
  provenance: "probe" as const,
  allowsModelSwitchWithinSession: false,
  reasonCode: "anthropic-probe-verified" as const,
  reason: "The endpoint passed the compatibility probe.",
});

function anthropicKey(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  const id = overrides.id ?? "custom:anthropic";
  return backendView<ModelBackendProfileDetail>({
    id,
    displayName: "Anthropic API key",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 1,
    endpointIdentity: `endpoint:${id}`,
    preset: "anthropic-api-key",
    baseUrl: "https://api.anthropic.com",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:1",
    models: [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", contextWindowTokens: null, reasoningOptions: [], capabilities: [] },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", contextWindowTokens: null, reasoningOptions: [], capabilities: [] },
    ],
    routing: { mode: "simple", primaryModelId: "claude-opus-5-5" },
    capabilityHints: [],
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    endpointHost: "api.anthropic.com",
    authState: "configured",
    connectionState: "connected",
    compatibility: verified(id),
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  });
}

function kimiRoute(overrides: Partial<ModelBackendProfileDetail> = {}): ModelBackendProfileDetail {
  return anthropicKey({
    id: "builtin:kimi-code",
    displayName: "Kimi",
    source: "built-in",
    preset: "kimi-code",
    baseUrl: "https://api.kimi.com/coding",
    endpointHost: "api.kimi.com",
    enabled: false,
    authState: "missing",
    connectionState: "not-tested",
    credentialGeneration: null,
    canDelete: false,
    providerId: "kimi",
    models: [{
      id: "kimi-for-coding",
      displayName: "Kimi for Coding",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
      compatibility: verified("builtin:kimi-code"),
      latestProbe: null,
    }],
    compatibility: { ...verified("builtin:kimi-code"), state: "unknown", reasonCode: "probe-required", reason: "Add a key and test this route." },
    ...overrides,
  });
}

function withProbes(
  profile: ModelBackendProfileDetail,
  failures: Readonly<Record<string, string>> = {},
): ModelBackendProfileDetail {
  return {
    ...profile,
    connectionState: Object.keys(failures).length === profile.models.length ? "failed" : "connected",
    models: profile.models.map((model) => ({
      ...model,
      latestProbe: probeResult(
        profile.id,
        model.id,
        failures[model.id]
          ? { code: "invalid-credentials", message: failures[model.id]!, retryAfterSeconds: null }
          : null,
        profile.configurationRevision,
      ),
    })),
  };
}

function props(overrides: Partial<Props> = {}): Props {
  const key = anthropicKey();
  return {
    profiles: [key, kimiRoute()],
    providers: [
      provider("claude", { authState: "unauthenticated", canRun: false }),
      provider("codex"),
      provider("opencode", { authState: "unknown" }),
      provider("cursor", { installState: "not-installed", available: false, canRun: false, authState: "unknown" }),
      provider("kimi"),
      provider("antigravity"),
    ],
    providerIdentityLabels: { codex: "Work" },
    disabled: false,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    onLoadDetail: vi.fn(async () => key),
    onCreate: vi.fn(async () => key),
    onUpdate: vi.fn(async () => key),
    onSetCredential: vi.fn(async () => key),
    onClearCredential: vi.fn(async () => key),
    onProbe: vi.fn(async () => withProbes(key)),
    onDiscoverModels: vi.fn(async () => []),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

function card(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("Accounts and API keys", () => {
  it("shows one card per provider with the real account state and the key routes it owns", () => {
    render(<ModelBackendsSettings {...props()} />);
    expect(screen.getByRole("heading", { name: "Accounts and API keys" })).toBeInTheDocument();
    expect(screen.getByText(/A chat uses one route at a time: the account, or an API key you choose in the model chooser/u)).toBeInTheDocument();
    const cards = screen.getAllByRole("region").flatMap((region) => region.dataset.providerCard ?? []);
    expect(cards).toEqual(["claude", "codex", "opencode", "cursor", "kimi", "antigravity", "pi"]);

    const claude = card("Claude Code");
    expect(within(claude).getByText("Signed out")).toBeInTheDocument();
    const keyRow = within(claude).getByRole("listitem", { name: "Anthropic API key" });
    expect(within(keyRow).getByText("Ready")).toBeInTheDocument();
    for (const name of ["Replace key for Anthropic API key", "Test Anthropic API key (uses a little credit)", "Models for Anthropic API key", "Turn off Anthropic API key", "Remove Anthropic API key"]) {
      expect(within(keyRow).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(claude).getByRole("button", { name: "Add API key for Claude Code" })).toBeInTheDocument();

    expect(within(card("Codex")).getByText("Signed in as Work")).toBeInTheDocument();
    expect(within(card("Codex")).getByText(/Add an OpenAI API key to use your API credits/u)).toBeInTheDocument();
    expect(within(card("Codex")).getByRole("button", { name: "Add API key for Codex" })).toBeInTheDocument();

    const opencode = card("OpenCode");
    expect(within(opencode).getByText(/opencode auth login/u)).toBeInTheDocument();
    expect(within(opencode).getByRole("button", { name: "Sign in through OpenCode" })).toBeInTheDocument();
    expect(within(opencode).queryByRole("button", { name: /Add API key/u })).not.toBeInTheDocument();

    expect(within(card("Cursor")).getByText("Not installed")).toBeInTheDocument();
    expect(within(card("Cursor")).getByText(/Account only/u)).toBeInTheDocument();
    expect(within(card("Antigravity")).getByText("Google says wrapping agy in another app isn't supported on consumer plans.")).toBeInTheDocument();
    expect(within(card("Antigravity")).getByText("Account only.")).toBeInTheDocument();
    expect(within(card("Antigravity")).queryByRole("button", { name: /Add API key/u })).not.toBeInTheDocument();
    expect(within(card("Cursor")).getByText("Account only, with usage not reported.")).toBeInTheDocument();
    expect(within(card("Codex")).getByRole("button", { name: "Refresh Codex" })).toBeInTheDocument();
    expect(within(card("Claude Code")).getByRole("button", { name: "Sign in through Claude Code" })).toBeInTheDocument();

    const kimi = card("Kimi Code");
    expect(within(claude).queryByText("Kimi")).not.toBeInTheDocument();
    const kimiRow = within(kimi).getByRole("listitem", { name: "Kimi" });
    expect(within(kimiRow).getByText("Needs a key")).toBeInTheDocument();
    expect(within(kimiRow).getByRole("button", { name: "Add key for Kimi" })).toBeInTheDocument();
    expect(within(kimiRow).queryByRole("button", { name: /Remove/u })).not.toBeInTheDocument();
    expect(within(kimi).queryByRole("button", { name: /Add API key/u })).not.toBeInTheDocument();
  });

  it("offers Claude account and API billing sign-in from a keyboard-operable menu", async () => {
    const user = userEvent.setup();
    const onConnectProvider = vi.fn();
    render(<ModelBackendsSettings {...props({ onConnectProvider })} />);
    const trigger = within(card("Claude Code")).getByRole("button", { name: "Sign in through Claude Code" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Claude Code sign-in" });
    const account = within(menu).getByRole("menuitem", { name: /^Sign in through Claude Code/u });
    const console = within(menu).getByRole("menuitem", { name: /Sign in for API billing through Claude Code/u });
    expect(console).toHaveTextContent("Uses your Anthropic Console credits.");
    account.focus();
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(console).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onConnectProvider).toHaveBeenCalledWith("claude", "console");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Sign in through Claude Code/u }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onConnectProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps a single Connect for providers without an API billing sign-in", async () => {
    const onConnectProvider = vi.fn();
    render(<ModelBackendsSettings {...props({
      onConnectProvider,
      providers: [provider("codex", { authState: "unauthenticated", canRun: false })],
    })} />);
    const connect = within(card("Codex")).getByRole("button", { name: "Sign in through Codex" });
    expect(connect).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(connect);
    expect(onConnectProvider).toHaveBeenCalledWith("codex");
  });
});

function keyChecked(
  profile: ModelBackendProfileDetail,
  failure: string | null = null,
): ModelBackendProfileDetail {
  return {
    ...profile,
    connectionState: failure ? "failed" : "connected",
    latestProbe: failure
      ? probeResult(profile.id, profile.routing.primaryModelId, { code: "invalid-credentials", message: failure, retryAfterSeconds: null }, profile.configurationRevision)
      : null,
  };
}

describe("Add API key", () => {
  it("creates the route, stores the key, checks it with the free key check, turns it on and closes", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", enabled: false, authState: "missing", connectionState: "not-tested" });
    const keyed = { ...created, authState: "configured" as const };
    const onCreate = vi.fn(async () => created);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => keyChecked(keyed));
    const onUpdate = vi.fn(async () => ({ ...keyChecked(keyed), enabled: true }));
    render(<ModelBackendsSettings {...props({ onCreate, onSetCredential, onProbe, onUpdate })} />);
    const add = screen.getByRole("button", { name: "Add API key for Claude Code" });
    await user.click(add);
    const dialog = screen.getByRole("dialog", { name: "Add Anthropic API key" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Anthropic API key");
    const key = within(dialog).getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("autocomplete", "off");
    expect(key).toHaveAccessibleDescription("Create one in the Anthropic Console. Usage is billed to your API credits.");
    expect(key).toHaveFocus();
    await user.type(key, "  sk-ant-test-key  {Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledWith({ preset: "anthropic-api-key", displayName: "Anthropic API key" });
    expect(onSetCredential).toHaveBeenCalledWith("custom:new", "sk-ant-test-key");
    expect(onProbe).toHaveBeenCalledExactlyOnceWith("custom:new", []);
    expect(onUpdate).toHaveBeenCalledWith("custom:new", { enabled: true });
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("shows the new route as Setting up… while the dialog works, even after it is closed", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", displayName: "Personal key", enabled: false, authState: "missing", connectionState: "not-tested" });
    const keyed = { ...created, authState: "configured" as const };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const onProbe = vi.fn(async () => { await held; return keyChecked(keyed); });
    const onUpdate = vi.fn(async () => ({ ...keyChecked(keyed), enabled: true }));
    render(<ModelBackendsSettings {...props({
      profiles: [],
      onCreate: vi.fn(async () => created),
      onSetCredential: vi.fn(async () => keyed),
      onProbe,
      onUpdate,
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Personal key");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    const row = await screen.findByRole("listitem", { name: "Personal key" });
    expect(row).toHaveTextContent("Setting up…");
    await user.click(within(dialog).getByRole("button", { name: "Close and continue" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("custom:new", { enabled: true }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Personal key" })).not.toBeInTheDocument());
  });

  it("checks the key before sending anything", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ModelBackendsSettings {...props({ onCreate })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Codex" }));
    const dialog = screen.getByRole("dialog", { name: "Add OpenAI API key" });
    await user.click(within(dialog).getByRole("button", { name: "Add API key" }));
    const key = within(dialog).getByLabelText("API key");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key).toHaveAccessibleDescription(/Paste an API key or token/u);
    expect(key).toHaveAccessibleDescription(/Create one at platform\.openai\.com\. Usage is billed to your API credits\./u);
    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(key, "sk-test");
    await user.click(within(dialog).getByRole("button", { name: "Add API key" }));
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription("Enter a name for this backend.");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("keeps the dialog open on a failed create and retries without duplicates", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error("Model IDs must be unique."))
      .mockResolvedValueOnce(created);
    const onSetCredential = vi.fn(async () => keyed);
    render(<ModelBackendsSettings {...props({
      onCreate,
      onSetCredential,
      onProbe: vi.fn(async () => keyChecked(keyed)),
      onUpdate: vi.fn(async () => ({ ...keyChecked(keyed), enabled: true })),
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Model IDs must be unique.");
    expect(within(within(dialog).getByRole("list", { name: "Setup progress" })).getByText("Failed")).toBeInTheDocument();
    expect(onSetCredential).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it("retries a failed key store without creating the route again", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onCreate = vi.fn(async () => created);
    const onSetCredential = vi.fn()
      .mockRejectedValueOnce(new Error("The credential vault is locked."))
      .mockResolvedValueOnce(keyed);
    render(<ModelBackendsSettings {...props({
      onCreate,
      onSetCredential,
      onProbe: vi.fn(async () => keyChecked(keyed)),
      onUpdate: vi.fn(async () => ({ ...keyChecked(keyed), enabled: true })),
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The credential vault is locked.");
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onSetCredential).toHaveBeenCalledTimes(2);
  });

  it("shows the key check's failure, keeps the route off, and stores a corrected key before checking again", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onCreate = vi.fn(async () => created);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn()
      .mockResolvedValueOnce(keyChecked(keyed, "The API key was rejected."))
      .mockResolvedValueOnce(keyChecked(keyed));
    const onUpdate = vi.fn(async () => ({ ...keyChecked(keyed), enabled: true }));
    render(<ModelBackendsSettings {...props({ onCreate, onSetCredential, onProbe, onUpdate })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    const key = within(dialog).getByLabelText("API key");
    await user.type(key, "sk-wrong{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The API key was rejected.");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", "Stored secret, enter a new value to replace");
    await user.type(key, "sk-right{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onSetCredential).toHaveBeenNthCalledWith(2, "custom:new", "sk-right");
    expect(onProbe).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("custom:new", { enabled: true });
  });

  it("offers Try again on the row when setup failed after the dialog closed", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", displayName: "Personal key", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onProbe = vi.fn()
      .mockResolvedValueOnce(keyChecked(keyed, "The provider did not answer."))
      .mockResolvedValueOnce(keyChecked(keyed));
    const onUpdate = vi.fn(async () => ({ ...keyChecked(keyed), enabled: true }));
    const view = render(<ModelBackendsSettings {...props({
      profiles: [],
      onCreate: vi.fn(async () => created),
      onSetCredential: vi.fn(async () => keyed),
      onProbe,
      onUpdate,
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Personal key");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    view.rerender(<ModelBackendsSettings {...props({ profiles: [keyed], onProbe, onUpdate })} />);
    const row = screen.getByRole("listitem", { name: "Personal key" });
    expect(row).toHaveTextContent("Failed: The provider did not answer.");
    await user.click(within(row).getByRole("button", { name: "Try again for Personal key" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("custom:new", { enabled: true }));
    expect(onProbe).toHaveBeenLastCalledWith("custom:new", []);
    await waitFor(() => expect(row).not.toHaveTextContent("Failed:"));
  });

  it("discovers models after the key is saved and adds the chosen ones before the key check", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onDiscoverModels = vi.fn(async () => [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    ]);
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) =>
      update.enabled ? { ...keyChecked(keyed), enabled: true } : keyed);
    render(<ModelBackendsSettings {...props({
      onCreate: vi.fn(async () => created),
      onSetCredential: vi.fn(async () => keyed),
      onDiscoverModels,
      onUpdate,
      onProbe: vi.fn(async () => keyChecked(keyed)),
    })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Discover models from the endpoint/u }));
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    const picker = await within(dialog).findByRole("group", { name: "Discovered models" });
    await user.type(within(picker).getByRole("searchbox", { name: "Search discovered models" }), "haiku");
    expect(within(picker).queryByText("Claude Opus 5.5")).not.toBeInTheDocument();
    await user.click(within(picker).getByRole("checkbox", { name: /Claude Haiku 5.5/u }));
    await user.click(within(picker).getByRole("button", { name: "Use 1 model" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onDiscoverModels).toHaveBeenCalledWith("custom:new");
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:new", {
      models: [expect.objectContaining({ id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" })],
      routing: { mode: "simple", primaryModelId: "claude-haiku-5-5" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith("custom:new", { enabled: true });
  });

  it("closes on Escape and returns focus to Add API key", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props()} />);
    const add = screen.getByRole("button", { name: "Add API key for Claude Code" });
    await user.click(add);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });
});

describe("API key rows", () => {
  it("says replacing the key keeps the route and its chats, then tests the new key", async () => {
    const user = userEvent.setup();
    const key = anthropicKey();
    const onSetCredential = vi.fn(async () => ({ ...key, configurationRevision: 2 }));
    const onProbe = vi.fn(async () => withProbes(key));
    render(<ModelBackendsSettings {...props({ onSetCredential, onProbe })} />);
    await user.click(screen.getByRole("button", { name: "Replace key for Anthropic API key" }));
    const form = screen.getByRole("form", { name: "Replace key for Anthropic API key" });
    const input = within(form).getByLabelText("New API key");
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(/keeps this route, its chats and its models/u);
    await user.type(input, "sk-new{Enter}");
    await waitFor(() => expect(onProbe).toHaveBeenCalledWith("custom:anthropic"));
    expect(onSetCredential).toHaveBeenCalledWith("custom:anthropic", "sk-new");
    expect(screen.getByRole("list", { name: /^Test results for Anthropic API key/u })).toBeInTheDocument();
  });

  it("keeps the stored key when the replacement is left empty", async () => {
    const user = userEvent.setup();
    const onSetCredential = vi.fn();
    render(<ModelBackendsSettings {...props({ onSetCredential })} />);
    const replace = screen.getByRole("button", { name: "Replace key for Anthropic API key" });
    await user.click(replace);
    const input = screen.getByLabelText("New API key");
    expect(input).toHaveAttribute("placeholder", "Stored secret, enter a new value to replace");
    await user.type(input, "{Enter}");
    expect(onSetCredential).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "Replace key for Anthropic API key" })).not.toBeInTheDocument();
    expect(replace).toHaveFocus();
  });

  it("tests every model and shows each model's result with the failure reason", async () => {
    const user = userEvent.setup();
    const key = anthropicKey();
    let finish!: (value: ModelBackendProfileDetail) => void;
    const onProbe = vi.fn(() => new Promise<ModelBackendProfileDetail>((resolve) => { finish = resolve; }));
    render(<ModelBackendsSettings {...props({ onProbe })} />);
    const test = screen.getByRole("button", { name: /^Test Anthropic API key/u });
    test.focus();
    await user.click(test);
    expect(test).toHaveFocus();
    expect(test).toHaveAttribute("aria-disabled", "true");
    expect(test).toHaveTextContent("Testing…");
    await user.click(test);
    expect(onProbe).toHaveBeenCalledOnce();
    expect(onProbe).toHaveBeenCalledWith("custom:anthropic");
    await act(async () => finish(withProbes(key, { "claude-sonnet-5-5": "This model is not available to your organization." })));
    const results = screen.getByRole("list", { name: /^Test results for Anthropic API key/u });
    const items = within(results).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Claude Opus 5.5");
    expect(items[0]).toHaveTextContent("Works");
    expect(items[1]).toHaveTextContent("Failed: This model is not available to your organization.");
  });

  it("shows a route whose key passed the check as Ready before its models are tested", () => {
    const untested = anthropicKey();
    const pending = { ...untested.compatibility, state: "unknown" as const, provenance: "unknown" as const, reasonCode: "probe-required" as const, reason: "Test this model." };
    const checked = {
      ...untested,
      keyVerified: true,
      connectionState: "not-tested" as const,
      compatibility: pending,
      models: untested.models.map((model) => ({ ...model, compatibility: pending })),
    };
    render(<ModelBackendsSettings {...props({ profiles: [checked] })} />);
    expect(screen.getByRole("listitem", { name: "Anthropic API key" })).toHaveTextContent("Ready");
  });

  it("names a failed route's reason in its state", () => {
    const failed = withProbes(anthropicKey(), {
      "claude-opus-5-5": "The API key was rejected.",
      "claude-sonnet-5-5": "The API key was rejected.",
    });
    render(<ModelBackendsSettings {...props({ profiles: [failed] })} />);
    expect(screen.getByRole("listitem", { name: "Anthropic API key" }))
      .toHaveTextContent("Failed: Claude Opus 5.5: The API key was rejected.");
  });

  it("turns a route off and on through an update", async () => {
    const onUpdate = vi.fn(async () => anthropicKey());
    render(<ModelBackendsSettings {...props({ onUpdate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off Anthropic API key" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("custom:anthropic", { enabled: false }));
  });

  it("moves focus into the remove confirmation and back to Remove on cancel", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ModelBackendsSettings {...props({ onDelete })} />);
    const remove = screen.getByRole("button", { name: "Remove Anthropic API key" });
    await user.click(remove);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(remove).toHaveFocus();
    await user.click(remove);
    const confirm = screen.getByRole("button", { name: "Remove permanently" });
    confirm.focus();
    await user.click(confirm);
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(onDelete).toHaveBeenCalledOnce();
    await act(async () => finish());
  });

  it("adds discovered models through the models editor and saves them with an update", async () => {
    const user = userEvent.setup();
    const key = anthropicKey();
    const onDiscoverModels = vi.fn(async () => [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
      { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
    ]);
    const onUpdate = vi.fn(async () => key);
    const onProbe = vi.fn(async () => withProbes(key));
    render(<ModelBackendsSettings {...props({ onDiscoverModels, onUpdate, onProbe })} />);
    await user.click(screen.getByRole("button", { name: "Models for Anthropic API key" }));
    const form = await screen.findByRole("form", { name: "Edit Anthropic API key" });
    expect(within(form).getByText(/Connects to https:\/\/api\.anthropic\.com/u)).toBeInTheDocument();
    expect(within(form).queryByLabelText("Base URL")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Discover models" }));
    const picker = await within(form).findByRole("group", { name: "Discovered models" });
    expect(within(picker).getByRole("checkbox", { name: /Claude Opus 5.5/u })).toBeDisabled();
    expect(within(picker).getByText("Added")).toBeInTheDocument();
    await user.click(within(picker).getByRole("checkbox", { name: /Claude Haiku 5.5/u }));
    await user.click(within(picker).getByRole("button", { name: "Add 1 model" }));
    expect(within(form).getByLabelText("Model 3 ID")).toHaveValue("claude-haiku-5-5");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("custom:anthropic", {
      models: [
        expect.objectContaining({ id: "claude-opus-5-5" }),
        expect.objectContaining({ id: "claude-sonnet-5-5" }),
        expect.objectContaining({ id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" }),
      ],
    }));
    expect(onProbe).toHaveBeenCalledWith("custom:anthropic");
    const sent = (onUpdate.mock.calls as unknown as [string, { models: object[] }][])[0]![1];
    for (const model of sent.models) {
      expect(Object.keys(model).sort()).toEqual(["capabilities", "contextWindowTokens", "displayName", "id", "reasoningOptions"]);
    }
  });

  it("opens the key field for a route the composer sent here", () => {
    render(<ModelBackendsSettings {...props({ initialProfileId: "builtin:kimi-code" })} />);
    const form = screen.getByRole("form", { name: "Add key for Kimi" });
    expect(within(form).getByLabelText("API key")).toHaveFocus();
  });
});

describe("Custom backend form", () => {
  async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole("button", { name: "Add custom backend…" }));
    return screen.getByRole("form", { name: "New custom backend" });
  }

  it("starts empty with placeholders and validates each field when Enter submits", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ModelBackendsSettings {...props({ onCreate })} />);
    const form = await openForm(user);
    const name = within(form).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("");
    expect(name).toHaveFocus();
    expect(within(form).getByRole("textbox", { name: "Base URL" })).toHaveValue("");
    expect(within(form).getByRole("textbox", { name: "Base URL" })).toHaveAttribute("placeholder", "https://gateway.example.com");
    expect(within(form).getByRole("textbox", { name: "Model 1 ID" })).toHaveValue("");
    expect(within(form).queryByDisplayValue("custom-model")).not.toBeInTheDocument();
    expect(within(form).queryByDisplayValue("https://api.example.com")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onCreate).not.toHaveBeenCalled();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter a name for this backend.");
    expect(within(form).getByRole("textbox", { name: "Base URL" })).toHaveAccessibleDescription("Enter the backend URL.");
    expect(within(form).getByRole("textbox", { name: "Model 1 ID" })).toHaveAccessibleDescription("Enter a model ID.");
    expect(name).toHaveFocus();

    await user.type(name, "Team gateway");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://gateway.example.test/v1?x=1");
    await user.keyboard("{Enter}");
    expect(within(form).getByRole("textbox", { name: "Base URL" })).toHaveAccessibleDescription("Backend URLs cannot contain a query string.");
  });

  it("lets the display name follow the model ID until it is edited and labels every row", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props()} />);
    const form = await openForm(user);
    await user.type(within(form).getByRole("textbox", { name: "Model 1 ID" }), "team-large");
    expect(within(form).getByRole("textbox", { name: "Model 1 display name" })).toHaveValue("team-large");
    await user.clear(within(form).getByRole("textbox", { name: "Model 1 display name" }));
    await user.type(within(form).getByRole("textbox", { name: "Model 1 display name" }), "Team large");
    await user.type(within(form).getByRole("textbox", { name: "Model 1 ID" }), "-v2");
    expect(within(form).getByRole("textbox", { name: "Model 1 display name" })).toHaveValue("Team large");
    await user.click(within(form).getByRole("button", { name: "Add model" }));
    expect(within(form).getByRole("textbox", { name: "Model 2 ID" })).toHaveValue("");
    expect(within(form).getByRole("spinbutton", { name: "Model 2 context tokens" })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Remove model 2" })).toBeInTheDocument();
  });

  it("shows the normalized URL, the private network switch and no unauthenticated Claude option", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props()} />);
    const form = await openForm(user);
    const authentication = within(form).getByRole("combobox", { name: "Authentication" });
    expect(within(authentication).queryByRole("option", { name: "No authentication" })).not.toBeInTheDocument();
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://gateway.example.test/v1/");
    expect(within(form).getByRole("textbox", { name: "Base URL" }))
      .toHaveAccessibleDescription("Inertia connects to https://gateway.example.test");
    expect(within(form).getByRole("switch", { name: "Allow private network addresses" })).toHaveAttribute("aria-checked", "false");
    expect(within(form).getByText(/Turn it on only for a server you trust/u)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: /Codex harness/u }));
    expect(within(within(form).getByRole("combobox", { name: "Authentication" })).getByRole("option", { name: "No authentication" })).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: "Base URL" }))
      .toHaveAccessibleDescription("Inertia connects to https://gateway.example.test/v1");
  });

  it("creates a custom backend with its key, checks the key, turns it on and closes the form", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:team", displayName: "Team gateway", preset: "custom", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onCreate = vi.fn(async () => created);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    const onUpdate = vi.fn(async () => ({ ...withProbes(keyed), enabled: true }));
    render(<ModelBackendsSettings {...props({ onCreate, onSetCredential, onProbe, onUpdate })} />);
    const form = await openForm(user);
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "Team gateway");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://gateway.example.test");
    await user.click(within(form).getByRole("switch", { name: "Allow private network addresses" }));
    await user.type(within(form).getByRole("textbox", { name: "Model 1 ID" }), "team-model");
    await user.type(within(form).getByLabelText("API key"), "team-secret{Enter}");
    await waitFor(() => expect(screen.queryByRole("form", { name: "New custom backend" })).not.toBeInTheDocument());
    expect(onProbe).toHaveBeenCalledExactlyOnceWith("custom:team", []);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      preset: "custom",
      displayName: "Team gateway",
      baseUrl: "https://gateway.example.test",
      allowPrivateNetwork: true,
      models: [expect.objectContaining({ id: "team-model", displayName: "team-model", reasoningOptions: [] })],
      routing: { mode: "simple", primaryModelId: "team-model" },
    }));
    expect(onSetCredential).toHaveBeenCalledWith("custom:team", "team-secret");
    expect(onUpdate).toHaveBeenCalledWith("custom:team", { enabled: true });
  });
});

function manyModels(count: number): ModelBackendProfileDetail["models"] {
  const base = anthropicKey().models[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `model-${index + 1}`,
    displayName: `Model ${index + 1}`,
  }));
}

describe("Route rules", () => {
  it("never turns on a route the person turned off when Test passes", async () => {
    const user = userEvent.setup();
    const off = anthropicKey({ enabled: false });
    const onUpdate = vi.fn(async () => off);
    const onProbe = vi.fn(async () => withProbes(off));
    render(<ModelBackendsSettings {...props({ profiles: [off], onUpdate, onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Anthropic API key/u }));
    await waitFor(() => expect(onProbe).toHaveBeenCalledOnce());
    await screen.findByRole("list", { name: /^Test results for Anthropic API key/u });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("turns a route on after its first key passes the test", async () => {
    const user = userEvent.setup();
    const kimi = kimiRoute();
    const keyed = { ...kimi, authState: "configured" as const };
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    const onUpdate = vi.fn(async () => ({ ...withProbes(keyed), enabled: true }));
    render(<ModelBackendsSettings {...props({ profiles: [kimi], onSetCredential, onProbe, onUpdate })} />);
    await user.click(screen.getByRole("button", { name: "Add key for Kimi" }));
    await user.type(within(screen.getByRole("form", { name: "Add key for Kimi" })).getByLabelText("API key"), "sk-kimi{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("builtin:kimi-code", { enabled: true }));
  });

  it("tests routes with more than 16 models in batches of 16", async () => {
    const user = userEvent.setup();
    const large = anthropicKey({ models: manyModels(20), routing: { mode: "simple", primaryModelId: "model-1" } });
    const onProbe = vi.fn(async () => withProbes(large));
    render(<ModelBackendsSettings {...props({ profiles: [large], onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Anthropic API key/u }));
    await waitFor(() => expect(onProbe).toHaveBeenCalledTimes(2));
    expect(onProbe).toHaveBeenNthCalledWith(1, "custom:anthropic", large.models.slice(0, 16).map(({ id }) => id));
    expect(onProbe).toHaveBeenNthCalledWith(2, "custom:anthropic", large.models.slice(16).map(({ id }) => id));
  });

  it("caps discovered models at 128 per route", async () => {
    const user = userEvent.setup();
    const crowded = anthropicKey({ models: manyModels(127), routing: { mode: "simple", primaryModelId: "model-1" } });
    render(<ModelBackendsSettings {...props({
      profiles: [crowded],
      onLoadDetail: vi.fn(async () => crowded),
      onDiscoverModels: vi.fn(async () => [
        { id: "extra-a", displayName: "Extra A" },
        { id: "extra-b", displayName: "Extra B" },
      ]),
    })} />);
    await user.click(screen.getByRole("button", { name: "Models for Anthropic API key" }));
    const form = await screen.findByRole("form", { name: "Edit Anthropic API key" });
    await user.click(within(form).getByRole("button", { name: "Discover models" }));
    const picker = await within(form).findByRole("group", { name: "Discovered models" });
    expect(within(picker).getByText("A route can list at most 128 models. You can choose 1 more.")).toBeInTheDocument();
    await user.click(within(picker).getByRole("checkbox", { name: /Extra A/u }));
    expect(within(picker).getByRole("checkbox", { name: /Extra B/u })).toBeDisabled();
  });

  it("asks for the key again before saving a new address, then stores it, tests and turns the route back on", async () => {
    const user = userEvent.setup();
    const custom = anthropicKey({ id: "custom:team", displayName: "Team gateway", preset: "custom", baseUrl: "https://gateway.example.test" });
    const moved = { ...custom, configurationRevision: 2, enabled: false, authState: "missing" as const };
    const keyed = { ...moved, authState: "configured" as const };
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) => update.enabled ? { ...withProbes(keyed), enabled: true } : moved);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    render(<ModelBackendsSettings {...props({
      profiles: [custom],
      onLoadDetail: vi.fn(async () => custom),
      onUpdate,
      onSetCredential,
      onProbe,
    })} />);
    await user.click(screen.getByRole("button", { name: "Edit Team gateway" }));
    const form = await screen.findByRole("form", { name: "Edit Team gateway" });
    expect(within(form).queryByText(/Changing the address needs the key again/u)).not.toBeInTheDocument();
    const url = within(form).getByRole("textbox", { name: "Base URL" });
    await user.clear(url);
    await user.type(url, "https://moved.example.test");
    expect(within(form).getByText(/Changing the address needs the key again/u)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(onUpdate).not.toHaveBeenCalled();
    const key = within(form).getByLabelText("API key");
    expect(key).toHaveFocus();
    await user.type(key, "team-key{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:team", { enabled: true }));
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:team", { baseUrl: "https://moved.example.test" });
    expect(onSetCredential).toHaveBeenCalledWith("custom:team", "team-key");
    expect(onProbe).toHaveBeenCalledWith("custom:team");
  });

  it("shows a vault error without the Electron IPC wrapper", async () => {
    const user = userEvent.setup();
    const onSetCredential = vi.fn(async () => {
      throw new Error("Error invoking remote method 'backend-credential:set': Error: The credential vault is locked.");
    });
    render(<ModelBackendsSettings {...props({ onSetCredential })} />);
    await user.click(screen.getByRole("button", { name: "Replace key for Anthropic API key" }));
    await user.type(screen.getByLabelText("New API key"), "sk-new{Enter}");
    expect(await within(screen.getByRole("listitem", { name: "Anthropic API key" })).findByRole("alert"))
      .toHaveTextContent(/^The credential vault is locked\.$/u);
  });

  it("keeps plain Refresh for a Claude connection error", () => {
    render(<ModelBackendsSettings {...props({
      providers: [provider("claude", { authState: "error", canRun: false })],
    })} />);
    const claude = card("Claude Code");
    expect(within(claude).getByRole("button", { name: "Refresh Claude Code" })).not.toHaveAttribute("aria-haspopup");
    expect(within(claude).queryByRole("button", { name: /API billing/u })).not.toBeInTheDocument();
    expect(within(claude).queryByRole("button", { name: "Sign in through Claude Code" })).not.toBeInTheDocument();
  });

  it("lets a signed-in Claude user sign in for API billing beside Refresh", async () => {
    const user = userEvent.setup();
    const onConnectProvider = vi.fn();
    const onRefreshProvider = vi.fn();
    render(<ModelBackendsSettings {...props({ providers: [provider("claude")], onConnectProvider, onRefreshProvider })} />);
    const claude = card("Claude Code");
    await user.click(within(claude).getByRole("button", { name: "Sign in for API billing through Claude Code" }));
    expect(onConnectProvider).toHaveBeenCalledWith("claude", "console");
    await user.click(within(claude).getByRole("button", { name: "Refresh Claude Code" }));
    expect(onRefreshProvider).toHaveBeenCalledWith("claude");
  });

  it("refreshes test results after a background renewal at the same revision", async () => {
    const user = userEvent.setup();
    const key = anthropicKey();
    const first = withProbes(key);
    const { rerender } = render(<ModelBackendsSettings {...props({ profiles: [key], onProbe: vi.fn(async () => first) })} />);
    await user.click(screen.getByRole("button", { name: /^Test Anthropic API key/u }));
    const results = await screen.findByRole("list", { name: /^Test results for Anthropic API key/u });
    await waitFor(() => expect(within(results).getAllByText("Works")).toHaveLength(2));
    const renewed = withProbes(key, { "claude-sonnet-5-5": "The model was retired." });
    const later = {
      ...renewed,
      models: renewed.models.map((model) => ({
        ...model,
        latestProbe: { ...model.latestProbe!, checkedAt: "2026-10-25T10:00:00.000Z" },
      })),
    };
    rerender(<ModelBackendsSettings {...props({ profiles: [later], onProbe: vi.fn(async () => first) })} />);
    expect(within(screen.getByRole("list", { name: /^Test results for Anthropic API key/u }))
      .getByText("Failed: The model was retired.")).toBeInTheDocument();
  });

  it("keeps the Model ID field focused while its identifier is typed in the editor", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props()} />);
    await user.click(screen.getByRole("button", { name: "Models for Anthropic API key" }));
    const form = await screen.findByRole("form", { name: "Edit Anthropic API key" });
    const modelId = within(form).getByRole("textbox", { name: "Model 1 ID" });
    await user.click(modelId);
    await user.keyboard("{End}-next");
    expect(within(form).getByRole("textbox", { name: "Model 1 ID" })).toHaveValue("claude-opus-5-5-next");
    expect(within(form).getByRole("textbox", { name: "Model 1 ID" })).toHaveFocus();
  });
});

describe("Keyless Claude-compatible routes", () => {
  const message = "Add an API key or bearer token to use this backend.";

  function keyless(): ModelBackendProfileDetail {
    const key = anthropicKey({
      id: "custom:open",
      displayName: "Open gateway",
      preset: "custom",
      authenticationMode: "none",
      authState: "not-required",
      enabled: false,
      baseUrl: "https://open.example.test",
    });
    const refused = { ...key.compatibility, state: "unavailable" as const, provenance: "built-in" as const, reasonCode: "credential-required" as const, reason: message };
    return {
      ...key,
      routeKind: "api-key",
      connectionState: "not-tested",
      compatibility: refused,
      models: key.models.map((model) => ({ ...model, compatibility: refused })),
    };
  }

  it("asks for a key on the row, switches the route to API key authentication, then stores and tests it", async () => {
    const user = userEvent.setup();
    const open = keyless();
    const switched = { ...open, authenticationMode: "api-key" as const, authState: "missing" as const };
    const offCompatibility = { ...open.compatibility, reasonCode: "profile-disabled" as const, reason: "Turn this backend on to use it." };
    const keyed = {
      ...switched,
      authState: "configured" as const,
      compatibility: offCompatibility,
      models: switched.models.map((model) => ({ ...model, compatibility: offCompatibility })),
    };
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) => update.enabled ? { ...withProbes(keyed), enabled: true } : switched);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    render(<ModelBackendsSettings {...props({ profiles: [open], onUpdate, onSetCredential, onProbe })} />);
    const row = screen.getByRole("listitem", { name: "Open gateway" });
    expect(row).toHaveTextContent("Needs a key");
    expect(within(row).getByRole("button", { name: /^Test Open gateway/u })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(row).getByRole("button", { name: "Add key for Open gateway" }));
    await user.type(within(row).getByLabelText("API key"), "open-key{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:open", { enabled: true }));
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:open", { authenticationMode: "api-key" });
    expect(onUpdate.mock.invocationCallOrder[0]!).toBeLessThan(onSetCredential.mock.invocationCallOrder[0]!);
    expect(onSetCredential).toHaveBeenCalledWith("custom:open", "open-key");
  });

  it("asks for the key again when an update removed it without an address change", async () => {
    const user = userEvent.setup();
    const custom = anthropicKey({ id: "custom:team", displayName: "Team gateway", preset: "custom", baseUrl: "https://gateway.example.test" });
    const cleared = { ...custom, configurationRevision: 2, enabled: false, authState: "missing" as const };
    const keyed = { ...cleared, authState: "configured" as const };
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) => update.enabled ? { ...withProbes(keyed), enabled: true } : cleared);
    const onSetCredential = vi.fn(async () => keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    render(<ModelBackendsSettings {...props({
      profiles: [custom],
      onLoadDetail: vi.fn(async () => custom),
      onUpdate,
      onSetCredential,
      onProbe,
    })} />);
    await user.click(screen.getByRole("button", { name: "Edit Team gateway" }));
    const form = await screen.findByRole("form", { name: "Edit Team gateway" });
    await user.click(within(form).getByRole("switch", { name: "Allow private network addresses" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("The key was removed with this change. Paste it again to finish.");
    expect(onSetCredential).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText("API key"), "team-key{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:team", { enabled: true }));
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onSetCredential).toHaveBeenCalledWith("custom:team", "team-key");
    expect(onProbe).toHaveBeenCalledWith("custom:team");
  });
});

describe("Long model lists", () => {
  it("keeps testing the models a pass skipped and shows how many are done", async () => {
    const user = userEvent.setup();
    const large = anthropicKey({ models: manyModels(20), routing: { mode: "simple", primaryModelId: "model-1" } });
    const tested = withProbes(large);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const onProbe = vi.fn()
      .mockImplementationOnce(async () => ({ ...tested, skippedModelIds: ["model-15", "model-16"] }))
      .mockImplementationOnce(async () => { await held; return tested; })
      .mockImplementationOnce(async () => tested);
    render(<ModelBackendsSettings {...props({ profiles: [large], onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Anthropic API key/u }));
    const row = screen.getByRole("listitem", { name: "Anthropic API key" });
    expect(await within(row).findByText("Tested 14 of 20 models…")).toBeInTheDocument();
    await act(async () => release());
    await waitFor(() => expect(onProbe).toHaveBeenCalledTimes(2));
    expect(onProbe).toHaveBeenNthCalledWith(1, "custom:anthropic", large.models.slice(0, 16).map(({ id }) => id));
    expect(onProbe).toHaveBeenNthCalledWith(2, "custom:anthropic", ["model-15", "model-16", "model-17", "model-18", "model-19", "model-20"]);
    await waitFor(() => expect(within(row).queryByText(/Tested \d+ of/u)).not.toBeInTheDocument());
    expect(within(row).getByRole("list", { name: /^Test results for Anthropic API key/u })).toBeInTheDocument();
  });

  it("stops with a reason when the backend keeps skipping the same models", async () => {
    const user = userEvent.setup();
    const key = anthropicKey();
    const onProbe = vi.fn(async () => ({ ...withProbes(key), skippedModelIds: ["claude-opus-5-5", "claude-sonnet-5-5"] }));
    render(<ModelBackendsSettings {...props({ onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Anthropic API key/u }));
    expect(await within(screen.getByRole("listitem", { name: "Anthropic API key" })).findByRole("alert"))
      .toHaveTextContent("The backend did not answer in time. Tested 0 of 2 models.");
    expect(onProbe).toHaveBeenCalledTimes(2);
  });
});

describe("Interrupted key replacement", () => {
  it("keeps asking for the key after an address change when storing it fails, and Save retries only the store", async () => {
    const user = userEvent.setup();
    const custom = anthropicKey({ id: "custom:team", displayName: "Team gateway", preset: "custom", baseUrl: "https://gateway.example.test" });
    const moved = { ...custom, configurationRevision: 2, enabled: false, authState: "missing" as const };
    const keyed = { ...moved, authState: "configured" as const };
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) => update.enabled ? { ...withProbes(keyed), enabled: true } : moved);
    const onSetCredential = vi.fn()
      .mockRejectedValueOnce(new Error("The credential vault is locked."))
      .mockResolvedValueOnce(keyed);
    const onProbe = vi.fn(async () => withProbes(keyed));
    render(<ModelBackendsSettings {...props({
      profiles: [custom],
      onLoadDetail: vi.fn(async () => custom),
      onUpdate,
      onSetCredential,
      onProbe,
    })} />);
    await user.click(screen.getByRole("button", { name: "Edit Team gateway" }));
    const form = await screen.findByRole("form", { name: "Edit Team gateway" });
    const url = within(form).getByRole("textbox", { name: "Base URL" });
    await user.clear(url);
    await user.type(url, "https://moved.example.test");
    await user.type(within(form).getByLabelText("API key"), "team-key{Enter}");
    expect(await within(form).findByRole("alert")).toHaveTextContent("The credential vault is locked.");
    const key = within(form).getByLabelText("API key");
    expect(key).toHaveValue("team-key");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:team", { enabled: true }));
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:team", { baseUrl: "https://moved.example.test" });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onSetCredential).toHaveBeenCalledTimes(2);
    expect(onSetCredential).toHaveBeenLastCalledWith("custom:team", "team-key");
    expect(onProbe).toHaveBeenCalledWith("custom:team");
  });
});

describe("Discovery after the dialog closes", () => {
  it("pauses setup on the row when the dialog closes at the model picker, and continues from there", async () => {
    const user = userEvent.setup();
    const created = anthropicKey({ id: "custom:new", displayName: "Personal key", enabled: false, authState: "missing" });
    const keyed = { ...created, authState: "configured" as const };
    const onDiscoverModels = vi.fn(async () => [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    ]);
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) =>
      update.enabled ? { ...keyChecked(keyed), enabled: true } : keyed);
    const onProbe = vi.fn(async () => keyChecked(keyed));
    const actions = {
      onCreate: vi.fn(async () => created),
      onSetCredential: vi.fn(async () => keyed),
      onDiscoverModels,
      onUpdate,
      onProbe,
    };
    const view = render(<ModelBackendsSettings {...props({ profiles: [], ...actions })} />);
    await user.click(screen.getByRole("button", { name: "Add API key for Claude Code" }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Personal key");
    await user.click(within(dialog).getByRole("radio", { name: /Discover models from the endpoint/u }));
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant{Enter}");
    await within(dialog).findByRole("group", { name: "Discovered models" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<ModelBackendsSettings {...props({ profiles: [keyed], ...actions })} />);
    const row = screen.getByRole("listitem", { name: "Personal key" });
    expect(row).toHaveTextContent("Setup paused: choose models to continue");
    await user.click(within(row).getByRole("button", { name: "Choose models for Personal key" }));
    const reopened = screen.getByRole("dialog");
    const picker = within(reopened).getByRole("group", { name: "Discovered models" });
    await user.click(within(picker).getByRole("checkbox", { name: /Claude Haiku 5.5/u }));
    await user.click(within(picker).getByRole("button", { name: "Use 1 model" }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:new", { enabled: true }));
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:new", {
      models: [expect.objectContaining({ id: "claude-haiku-5-5" })],
      routing: { mode: "simple", primaryModelId: "claude-haiku-5-5" },
    });
    expect(onDiscoverModels).toHaveBeenCalledOnce();
    expect(actions.onCreate).toHaveBeenCalledOnce();
    expect(onProbe).toHaveBeenCalledExactlyOnceWith("custom:new", []);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(row).not.toHaveTextContent("Setup paused"));
  });
});
