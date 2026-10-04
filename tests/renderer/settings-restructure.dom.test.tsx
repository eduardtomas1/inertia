import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { defaultSettings, type ModelBackendProfileView } from "../../src/shared/contracts";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { RESTORE_DEFAULTS_CONFIRMATION, RESTORE_DEFAULTS_SCOPE } from "../../src/shared/restore-defaults";
import { modelRouteIdentityKey } from "../../src/renderer/src/utils/modelFavorites";
import { conversation } from "./composer-fixtures";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;
}

function teamProfile(): ModelBackendProfileView {
  return {
    id: "custom:team",
    displayName: "Team gateway",
    harnessId: "codex-app-server",
    protocol: "openai-responses",
    authenticationMode: "none",
    source: "custom",
    enabled: true,
    configurationRevision: 2,
    endpointIdentity: "endpoint:team:2",
    preset: "custom",
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "team-model",
      displayName: "Team model",
      contextWindowTokens: 120_000,
      reasoningOptions: [{ value: "medium", label: "Medium", description: "Balanced reasoning" }],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "team-model" },
    capabilityHints: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    endpointHost: "team.example.test",
    authState: "not-required",
    connectionState: "connected",
    compatibility: {
      harnessId: "codex-app-server",
      backendProfileId: "custom:team",
      backendProtocol: "openai-responses",
      state: "partially-compatible",
      provenance: "probe",
      allowsModelSwitchWithinSession: false,
      reasonCode: "responses-probe-verified",
      reason: "The exact route was probed.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
  };
}

const teamSelection = modelSelectionSchema.parse({
  harnessId: "codex-app-server",
  backendProfileId: "custom:team",
  backendProfileDisplayName: "Team gateway",
  backendConfigurationRevision: 2,
  modelId: "team-model",
  alias: "Team model",
  reasoningEffort: "medium",
  contextWindowOverride: 120_000,
  providerOptions: {},
  capabilities: [],
});

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getPlatform: () => "darwin",
      getAppHealth: vi.fn(async () => null),
      getBackendCredentialState: vi.fn(async () => ({
        profileId: "discord-release-webhook",
        hasSecret: true,
        maskedValue: "••••",
        credentialGeneration: null,
        storage: { available: true, provider: "keychain" as const, message: null },
      })),
      reportValidationDiagnostic: vi.fn(async () => null),
      sendDiscordReleaseInfo: vi.fn(async () => ({ sent: true, comparisonLimited: false })),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("Settings navigation landmark", () => {
  it("lists the nine sections in a labelled navigation landmark", () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "appearance" } })} />);
    const navigation = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Appearance", "Chats", "Notifications", "Keyboard", "Projects", "Agents", "Devices & integrations", "Data", "Help",
    ]);
  });
});

describe("New chats single home", () => {
  it("shows the effective custom backend default once and leaves no new-chat defaults in Agents", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      providers: [settingsProvider("codex", "Codex"), settingsProvider("claude", "Claude")],
      backendProfiles: [teamProfile()],
      backendDefaults: [{ scope: "global", projectId: null, selection: teamSelection, updatedAt: "2026-08-01T00:00:00.000Z" }],
      onLoadBackendProfile: vi.fn(async () => ({ ...teamProfile(), baseUrl: "https://team.example.test/v1" })),
    })} />);
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue(modelRouteIdentityKey(teamSelection));
    expect((model as HTMLSelectElement).selectedOptions[0]).toHaveTextContent("Team model");
    expect(screen.getByRole("combobox", { name: "Reasoning" })).toHaveValue("medium");
    const newChatNames = ["Model", "Reasoning", "Work mode", "Access", "Where new chats run"];
    expect(within(screen.getByRole("region", { name: "New chats" })).getAllByRole("combobox")
      .map((select) => select.getAttribute("aria-label"))).toEqual(newChatNames);

    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    await screen.findByRole("heading", { name: "Custom backends" });
    expect(screen.queryByRole("combobox", { name: /default/iu })).toBeNull();
    for (const name of newChatNames) expect(screen.queryByRole("combobox", { name })).toBeNull();
    expect(screen.queryByText("New chat defaults")).toBeNull();
  });

  it("writes a native choice and clears the custom backend default in one command with one saved notice", async () => {
    const onSetDefaultModel = vi.fn(async () => undefined);
    const onSetBackendDefault = vi.fn(async () => undefined);
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      providers: [settingsProvider("codex", "Codex"), settingsProvider("claude", "Claude")],
      backendProfiles: [teamProfile()],
      backendDefaults: [{ scope: "global", projectId: null, selection: teamSelection, updatedAt: "2026-08-01T00:00:00.000Z" }],
      onSetDefaultModel,
      onSetBackendDefault,
      onUpdate,
    })} />);
    const claudeDefault = modelRouteIdentityKey(providerNativeModelSelection({ providerId: "claude" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: claudeDefault } });
    await waitFor(() => expect(within(row("new-chat-model")).getByRole("status")).toHaveTextContent("Saved"));
    expect(onSetDefaultModel).toHaveBeenCalledExactlyOnceWith({ defaultProvider: "claude", defaultModel: "", defaultReasoningEffort: "" });
    expect(onSetBackendDefault).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect([...document.querySelectorAll(".setting-status")].filter((status) => status.textContent)).toHaveLength(1);
  });

  it("sets a custom backend as the global default", async () => {
    const onSetBackendDefault = vi.fn(async () => undefined);
    const onSetDefaultModel = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      providers: [settingsProvider("codex", "Codex")],
      backendProfiles: [teamProfile()],
      onSetBackendDefault,
      onSetDefaultModel,
    })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: modelRouteIdentityKey(teamSelection) } });
    await waitFor(() => expect(onSetBackendDefault).toHaveBeenCalledOnce());
    expect(onSetBackendDefault).toHaveBeenCalledWith(null, expect.objectContaining({ backendProfileId: "custom:team", modelId: "team-model" }));
    expect(onSetDefaultModel).not.toHaveBeenCalled();
  });

  it("keeps the model select enabled and focused while saving and reports a rejected save in its row", async () => {
    let fail!: (error: Error) => void;
    const onSetBackendDefault = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      providers: [settingsProvider("codex", "Codex")],
      backendProfiles: [teamProfile()],
      onSetBackendDefault,
    })} />);
    const model = screen.getByRole("combobox", { name: "Model" });
    const before = (model as HTMLSelectElement).value;
    model.focus();
    fireEvent.change(model, { target: { value: modelRouteIdentityKey(teamSelection) } });
    expect(model).toBeEnabled();
    expect(model).toHaveFocus();
    expect(model).toHaveValue(modelRouteIdentityKey(teamSelection));
    await act(async () => fail(new Error("The default could not be stored.")));
    expect(within(row("new-chat-model")).getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(model).toHaveValue(before);
  });

  it("marks reasoning unavailable and shows Model default when the model exposes no levels", () => {
    const onSetDefaultModel = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({
      target: { section: "chats" },
      providers: [settingsProvider("codex", "Codex")],
      onSetDefaultModel,
    })} />);
    const reasoning = screen.getByRole("combobox", { name: "Reasoning" });
    expect(reasoning).toHaveAttribute("aria-disabled", "true");
    expect(reasoning).toBeEnabled();
    expect(reasoning).toHaveValue("");
    expect(within(reasoning).getAllByRole("option").map((option) => option.textContent)).toEqual(["Model default"]);
    fireEvent.change(reasoning, { target: { value: "" } });
    expect(onSetDefaultModel).not.toHaveBeenCalled();
  });
});

describe("Projects", () => {
  it("shows project grouping and compact sidebar for all projects and no second new-chat location", async () => {
    const onUpdate = vi.fn(async () => undefined);
    render(<SettingsView {...settingsViewProps({ target: { section: "projects" }, onUpdate })} />);
    const grouping = await screen.findByRole("radiogroup", { name: "Group projects" });
    expect(within(grouping).getByRole("radio", { name: "Keep separate" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Compact sidebar" }));
    expect(onUpdate).toHaveBeenCalledWith({ compactSidebar: true });
    expect(screen.queryByRole("combobox", { name: /workspace/iu })).toBeNull();
    expect(screen.queryByText("Workspace default")).toBeNull();
  });
});

describe("Archived chats paging", () => {
  const archived = Array.from({ length: 45 }, (_, index) => ({
    ...conversation(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    title: index % 2 === 0 ? `Even chat ${index}` : `Odd chat ${index}`,
    archivedAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T00:00:00.000Z`,
  }));

  it("shows twenty at a time newest first, moves focus to the first new chat and filters by title", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "data" }, archived, providers: [settingsProvider("codex", "Codex")] })} />);
    const list = await screen.findByRole("list", { name: "Archived chats" });
    const titles = () => within(list).getAllByRole("listitem").map((item) => item.querySelector("strong")!.textContent);
    expect(titles()).toHaveLength(20);
    const expectedOrder = [...archived]
      .sort((left, right) => right.archivedAt!.localeCompare(left.archivedAt!) || left.id.localeCompare(right.id))
      .map(({ title }) => title);
    expect(titles()).toEqual(expectedOrder.slice(0, 20));
    expect(screen.getByText("Showing 20 of 45")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(titles()).toEqual(expectedOrder.slice(0, 40));
    expect(within(list).getAllByRole("button")[20]).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(titles()).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/u })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter archived chats" }), { target: { value: "odd" } });
    expect(titles()).toHaveLength(20);
    expect(titles().every((title) => title!.startsWith("Odd"))).toBe(true);
    expect(screen.getByText("Showing 20 of 22")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter archived chats" }), { target: { value: "missing" } });
    expect(screen.getByText("No archived chats match this filter.")).toBeInTheDocument();
  });

  it("says so when nothing is archived", async () => {
    render(<SettingsView {...settingsViewProps({ target: { section: "data" } })} />);
    expect(await screen.findByText("No archived chats.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Filter archived chats" })).toBeNull();
  });
});

describe("Discord release post", () => {
  it("asks before posting, keeps focus on Cancel and posts only after confirmation", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "devices" },
      settings: { ...defaultSettings, discordReleaseRepositoryUrl: "https://github.com/org/repo" },
    })} />);
    const post = await screen.findByRole("button", { name: "Post release to Discord…" });
    await waitFor(() => expect(post).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(post);
    const confirm = screen.getByRole("group", { name: "Confirm Discord post" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(window.inertia.sendDiscordReleaseInfo).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm Discord post" })).toBeNull();
    expect(post).toHaveFocus();
    expect(window.inertia.sendDiscordReleaseInfo).not.toHaveBeenCalled();

    fireEvent.click(post);
    fireEvent.click(screen.getByRole("button", { name: "Post to Discord" }));
    await waitFor(() => expect(window.inertia.sendDiscordReleaseInfo).toHaveBeenCalledExactlyOnceWith({ repositoryUrl: "https://github.com/org/repo" }));
  });

  it("cancels the confirmation with Escape without leaving Settings and returns focus after posting", async () => {
    render(<SettingsView {...settingsViewProps({
      target: { section: "devices" },
      settings: { ...defaultSettings, discordReleaseRepositoryUrl: "https://github.com/org/repo" },
    })} />);
    const post = await screen.findByRole("button", { name: "Post release to Discord…" });
    await waitFor(() => expect(post).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(post);
    const cancel = within(screen.getByRole("group", { name: "Confirm Discord post" })).getByRole("button", { name: "Cancel" });
    expect(fireEvent.keyDown(cancel, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("group", { name: "Confirm Discord post" })).toBeNull();
    expect(post).toHaveFocus();

    fireEvent.click(post);
    fireEvent.click(screen.getByRole("button", { name: "Post to Discord" }));
    await waitFor(() => expect(window.inertia.sendDiscordReleaseInfo).toHaveBeenCalledOnce());
    expect(post).toHaveFocus();
  });
});

describe("Restore defaults", () => {
  it("states what it resets and keeps, asks first and runs the restore command", async () => {
    const onRestoreDefaults = vi.fn(async () => undefined);
    const onUpdate = vi.fn(async () => undefined);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<SettingsView {...settingsViewProps({ target: { section: "data" }, onRestoreDefaults, onUpdate })} />);
    const restore = within(await screen.findByText(RESTORE_DEFAULTS_SCOPE).then(() => row("restore-defaults")));
    fireEvent.click(restore.getByRole("button", { name: "Restore defaults" }));
    expect(confirm).toHaveBeenLastCalledWith(RESTORE_DEFAULTS_CONFIRMATION);
    expect(onRestoreDefaults).not.toHaveBeenCalled();
    fireEvent.click(restore.getByRole("button", { name: "Restore defaults" }));
    await act(async () => undefined);
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(await restore.findByText("Defaults restored.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
