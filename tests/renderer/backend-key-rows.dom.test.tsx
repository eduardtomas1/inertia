import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelBackendsSettings } from "../../src/renderer/src/components/ModelBackendsSettings";
import type { ModelBackendProfileDetail } from "../../src/shared/contracts";
import { backendView } from "./backend-view-fixtures";

type Props = ComponentProps<typeof ModelBackendsSettings>;

function profile(
  id: string,
  displayName: string,
  configurationRevision: number,
  overrides: Partial<ModelBackendProfileDetail> = {},
): ModelBackendProfileDetail {
  return backendView<ModelBackendProfileDetail>({
    id,
    displayName,
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: false,
    configurationRevision,
    endpointIdentity: `endpoint:${id}:${configurationRevision}`,
    preset: "custom",
    baseUrl: `https://${id.replace(":", "-")}.example.test`,
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: `${id}-model`,
      displayName: `${displayName} model`,
      contextWindowTokens: 128_000,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: `${id}-model` },
    capabilityHints: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    endpointHost: `${id.replace(":", "-")}.example.test`,
    authState: "missing",
    connectionState: "not-tested",
    compatibility: {
      harnessId: "claude-agent-sdk",
      backendProfileId: id,
      backendProtocol: "anthropic-messages",
      state: "unknown",
      provenance: "unknown",
      allowsModelSwitchWithinSession: false,
      reasonCode: "probe-required",
      reason: "Test this backend before enabling it.",
    },
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  });
}

function props(profiles: ModelBackendProfileDetail[], overrides: Partial<Props> = {}): Props {
  const byId = new Map(profiles.map((value) => [value.id, value]));
  const unexpected = (name: string) => vi.fn(async () => { throw new Error(`Unexpected ${name}`); });
  return {
    profiles,
    providers: [],
    disabled: false,
    onConnectProvider: vi.fn(),
    onRefreshProvider: vi.fn(),
    onLoadDetail: vi.fn(async (id: string) => byId.get(id)!),
    onCreate: unexpected("create"),
    onUpdate: unexpected("update"),
    onSetCredential: unexpected("credential"),
    onClearCredential: unexpected("credential clear"),
    onProbe: unexpected("probe"),
    onDiscoverModels: unexpected("discovery"),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  };
}

function row(name: string): HTMLElement {
  return screen.getByRole("listitem", { name });
}

describe("API key row identity", () => {
  it("keeps each row's key draft to itself and never saves one row's key to another", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const profileB = profile("custom:b", "Profile B", 1);
    const onSetCredential = vi.fn(async (id: string) => ({ ...(id === profileA.id ? profileA : profileB), authState: "configured" as const }));
    const onProbe = vi.fn(async (id: string) => (id === profileA.id ? profileA : profileB));
    render(<ModelBackendsSettings {...props([profileA, profileB], { onSetCredential, onProbe })} />);
    await user.click(screen.getByRole("button", { name: "Add key for Profile A" }));
    await user.type(within(row("Profile A")).getByLabelText("API key"), "profile-a-secret");
    await user.click(screen.getByRole("button", { name: "Add key for Profile B" }));
    const keyB = within(row("Profile B")).getByLabelText("API key");
    expect(keyB).toHaveValue("");
    await user.type(keyB, "profile-b-secret{Enter}");
    await waitFor(() => expect(onSetCredential).toHaveBeenCalledWith(profileB.id, "profile-b-secret"));
    expect(onSetCredential).not.toHaveBeenCalledWith(profileB.id, "profile-a-secret");
    expect(within(row("Profile A")).getByLabelText("API key")).toHaveValue("profile-a-secret");
  });

  it("clears and never saves a key draft when the route's configuration revision changes", async () => {
    const user = userEvent.setup();
    const revisionOne = profile("custom:a", "Profile A", 1);
    const onSetCredential = vi.fn(async () => revisionOne);
    const { rerender } = render(<ModelBackendsSettings {...props([revisionOne], { onSetCredential })} />);
    await user.click(screen.getByRole("button", { name: "Add key for Profile A" }));
    await user.type(within(row("Profile A")).getByLabelText("API key"), "revision-one-secret");
    rerender(<ModelBackendsSettings {...props([profile("custom:a", "Profile A", 2)], { onSetCredential })} />);
    await waitFor(() => expect(within(row("Profile A")).getByLabelText("API key")).toHaveValue(""));
    expect(onSetCredential).not.toHaveBeenCalled();
  });

  it("keeps another row's key draft while a background test finishes", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1, { authState: "configured" });
    const profileB = profile("custom:b", "Profile B", 1);
    let finish!: (value: ModelBackendProfileDetail) => void;
    const onProbe = vi.fn(() => new Promise<ModelBackendProfileDetail>((resolve) => { finish = resolve; }));
    render(<ModelBackendsSettings {...props([profileA, profileB], { onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Profile A/u }));
    await user.click(screen.getByRole("button", { name: "Add key for Profile B" }));
    const keyB = within(row("Profile B")).getByLabelText("API key");
    await user.type(keyB, "profile-b-draft");
    await act(async () => finish(profileA));
    expect(keyB).toHaveValue("profile-b-draft");
    expect(keyB).toHaveFocus();
  });

  it("shows a test failure only on the route that was tested", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1, { authState: "configured" });
    const profileB = profile("custom:b", "Profile B", 1);
    let reject!: (error: Error) => void;
    const onProbe = vi.fn(() => new Promise<ModelBackendProfileDetail>((_resolve, fail) => { reject = fail; }));
    render(<ModelBackendsSettings {...props([profileA, profileB], { onProbe })} />);
    await user.click(screen.getByRole("button", { name: /^Test Profile A/u }));
    await act(async () => { reject(new Error("Profile A endpoint is unavailable")); });
    expect(within(row("Profile A")).getByRole("alert")).toHaveTextContent("Profile A endpoint is unavailable");
    expect(within(row("Profile B")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a removed route's row quiet when the snapshot drops it before the delete resolves", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1);
    const profileB = profile("custom:b", "Profile B", 1);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const base = props([profileA, profileB], { onDelete: vi.fn(() => pending) });
    const { rerender } = render(<ModelBackendsSettings {...base} />);
    await user.click(screen.getByRole("button", { name: "Remove Profile A" }));
    await user.click(screen.getByRole("button", { name: "Remove permanently" }));
    rerender(<ModelBackendsSettings {...base} profiles={[profileB]} />);
    await act(async () => { finish(); await pending; });
    expect(screen.queryByRole("listitem", { name: "Profile A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Profile B" })).not.toHaveAttribute("aria-disabled");
  });
});

describe("Route editor", () => {
  it("locks the fields while a save is pending and keeps Cancel reachable by keyboard", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1, { authState: "configured" });
    const onUpdate = vi.fn(() => new Promise<ModelBackendProfileDetail>(() => undefined));
    render(<ModelBackendsSettings {...props([profileA], { onUpdate })} />);
    await user.click(screen.getByRole("button", { name: "Edit Profile A" }));
    const form = await screen.findByRole("form", { name: "Edit Profile A" });
    const name = within(form).getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    await user.type(name, " renamed{Enter}");
    expect(onUpdate).toHaveBeenCalledWith("custom:a", { displayName: "Profile A renamed" });
    expect(name).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
    const cancel = within(form).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("form", { name: "Edit Profile A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Profile A" })).toHaveFocus();
  });

  it("re-tests a changed connection and turns a route that was on back on", async () => {
    const user = userEvent.setup();
    const profileA = profile("custom:a", "Profile A", 1, { authState: "configured", enabled: true });
    const saved = { ...profileA, configurationRevision: 2, enabled: false };
    const tested = {
      ...saved,
      models: saved.models.map((model) => ({
        ...model,
        compatibility: { ...model.compatibility, state: "verified" as const, provenance: "probe" as const, reasonCode: "anthropic-probe-verified" as const },
        latestProbe: {
          profileId: saved.id,
          backendConfigurationRevision: 2,
          endpointIdentity: "endpoint:custom:a:2",
          protocol: "anthropic-messages" as const,
          modelId: model.id,
          compatibility: "protocol-compatible" as const,
          protocolVerified: true,
          modelVerified: true,
          capabilities: [],
          contextWindow: { tokens: null, state: "unknown" as const, provenance: "unknown" as const, detail: null, checkedAt: "2026-10-24T10:00:00.000Z" },
          failure: null,
          checkedAt: "2026-10-24T10:00:00.000Z",
        },
      })),
    };
    const onUpdate = vi.fn(async (_id: string, update: { enabled?: boolean }) => update.enabled ? { ...tested, enabled: true } : saved);
    const onProbe = vi.fn(async () => tested);
    const onSetCredential = vi.fn(async () => saved);
    render(<ModelBackendsSettings {...props([profileA], { onUpdate, onProbe, onSetCredential })} />);
    await user.click(screen.getByRole("button", { name: "Edit Profile A" }));
    const form = await screen.findByRole("form", { name: "Edit Profile A" });
    const url = within(form).getByRole("textbox", { name: "Base URL" });
    await user.clear(url);
    await user.type(url, "https://moved.example.test");
    await user.type(within(form).getByLabelText("API key"), "moved-key{Enter}");
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith("custom:a", { enabled: true }));
    expect(onSetCredential).toHaveBeenCalledWith("custom:a", "moved-key");
    expect(onUpdate).toHaveBeenNthCalledWith(1, "custom:a", { baseUrl: "https://moved.example.test" });
    expect(onProbe).toHaveBeenCalledWith("custom:a");
  });

  it("keeps the harness choice state and a keyboard-operable model mapping radio group", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props([])} />);
    await user.click(screen.getByRole("button", { name: "Add custom backend…" }));
    const form = screen.getByRole("form", { name: "New custom backend" });
    expect(within(form).getByRole("button", { name: /Claude harness/u })).toHaveAttribute("aria-pressed", "true");
    expect(within(form).getByRole("button", { name: /Codex harness/u })).toHaveAttribute("aria-pressed", "false");
    await user.type(within(form).getByRole("textbox", { name: "Model 1 ID" }), "team-model");
    const mapping = within(form).getByRole("radiogroup", { name: "Model mapping" });
    const simple = within(mapping).getByRole("radio", { name: "Simple" });
    const advanced = within(mapping).getByRole("radio", { name: "Advanced" });
    expect(simple).toHaveAttribute("aria-checked", "true");
    simple.focus();
    await user.keyboard("{ArrowRight}");
    expect(advanced).toHaveFocus();
    expect(advanced).toHaveAttribute("aria-checked", "true");
    expect(within(form).getByRole("combobox", { name: "Subagents" })).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(simple).toHaveAttribute("aria-checked", "true");
    expect(within(form).queryByRole("combobox", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("returns focus to Add custom backend when the form is cancelled", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings {...props([])} />);
    await user.click(screen.getByRole("button", { name: "Add custom backend…" }));
    await user.click(within(screen.getByRole("form", { name: "New custom backend" })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add custom backend…" })).toHaveFocus();
  });
});
