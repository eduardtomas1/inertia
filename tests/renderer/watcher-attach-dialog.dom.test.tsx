import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ConversationLatestTurnSummary, ProviderId, ProviderInfo } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING, type WatcherLinkView } from "../../src/shared/watcher";
import { WatcherAttachDialog, WatcherAttachPresence } from "../../src/renderer/src/components/watcher/WatcherAttachDialog";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { MODEL_FAVORITES_STORAGE_KEY } from "../../src/renderer/src/utils/modelFavorites";
import { WATCHED_ID, link, payloadOf, project, recordingRequest, shell } from "./watcher-fixtures";

const tiers = vi.hoisted(() => ({ withoutReadOnly: new Set<string>() }));

vi.mock("../../src/shared/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/watcher")>();
  return {
    ...actual,
    watcherReadOnlyEnforcement: (harnessId: string) => tiers.withoutReadOnly.has(harnessId)
      ? null
      : actual.watcherReadOnlyEnforcement(harnessId),
  };
});

afterEach(() => {
  tiers.withoutReadOnly.clear();
  window.localStorage.removeItem(MODEL_FAVORITES_STORAGE_KEY);
});

const ready = (id: ProviderId, label: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  label,
  command: id,
  available: true,
  version: "1.0.0",
  executable: `/opt/bin/${id}`,
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: null,
  models: [{
    id: "fixture-model",
    label: "Fixture model",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  }],
  rateLimits: [],
  metadataState: {
    models: { freshness: "fresh", provenance: "provider", updatedAt: "2026-10-19T10:00:00.000Z", lastAttemptedAt: "2026-10-19T10:00:00.000Z", refreshing: false },
    rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
  },
  ...overrides,
});

function snapshot(providers: ProviderInfo[], watchedProvider: ProviderId = "codex"): AppSnapshot {
  return {
    projects: [project],
    conversations: [shell(WATCHED_ID, "Refactor parser", {
      providerId: watchedProvider,
      modelSelection: { ...providerNativeModelSelection({ providerId: watchedProvider }), modelId: "fixture-model" },
    })],
    runs: [],
    providers,
    settings: defaultSettings,
    activeProjectId: project.id,
    activeConversationId: WATCHED_ID,
  };
}

function Harness({ value, onAttached = vi.fn(), request }: {
  value: AppSnapshot;
  onAttached?: (link: WatcherLinkView) => void;
  request?: ReturnType<typeof recordingRequest>["request"];
}) {
  const [open, setOpen] = useState(false);
  const fallback = recordingRequest(() => ({ kind: "watcher.link", link: link() }));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Add a watcher…</button>
      {open && (
        <WatcherAttachDialog
          snapshot={value}
          settings={value.settings}
          watchedConversationId={WATCHED_ID}
          request={request ?? fallback.request}
          onClose={() => setOpen(false)}
          onAttached={onAttached}
          onOpenProviderSetup={vi.fn()}
          onOpenBackendSetup={vi.fn()}
        />
      )}
    </>
  );
}

async function openDialog(value: AppSnapshot, options: Parameters<typeof Harness>[0] extends infer P ? Omit<P, "value"> : never = {}) {
  render(<Harness value={value} {...options} />);
  const trigger = screen.getByRole("button", { name: "Add a watcher…" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Add a watcher" });
  return { trigger, dialog };
}

const tunable = (id: ProviderId, label: string): ProviderInfo => ready(id, label, {
  models: [{
    id: "fixture-model",
    label: "Fixture model",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "low", label: "Low", description: "" },
      { value: "medium", label: "Medium", description: "" },
      { value: "high", label: "High", description: "" },
    ],
    defaultReasoningEffort: "medium",
    fastMode: { providerValue: "priority", label: "Fast", description: "Faster replies that use more of the plan.", isDefault: false },
  }],
});

async function attachPayload(dialog: HTMLElement, request: ReturnType<typeof recordingRequest>["request"]) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Add watcher" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  return payloadOf(request.mock.calls.at(-1)![0]);
}

async function openChooser(dialog: HTMLElement) {
  const section = within(dialog).getByRole("heading", { name: "Model route" }).closest("section")!;
  fireEvent.click(section.querySelector<HTMLButtonElement>("button[aria-controls]")!);
  return screen.findByRole("dialog", { name: "Choose model" });
}

async function chooseRoute(dialog: HTMLElement, source: string, harnessId: string) {
  const chooser = await openChooser(dialog);
  fireEvent.click(await within(chooser).findByRole("button", { name: new RegExp(`^${source}, `, "u") }));
  const row = [...chooser.querySelectorAll<HTMLElement>("[data-model-route-key]")]
    .find((candidate) => candidate.dataset.modelRouteKey?.includes(harnessId) && candidate.getAttribute("aria-disabled") !== "true");
  expect(row).toBeDefined();
  fireEvent.click(row!.closest("button") ?? row!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument());
}

const INERTIA_TIER = "Inertia enforces it: approvals are declined, Codex runs its own known-safe commands inside its read-only sandbox, and a change to files pauses the watcher.";
const ALLOWLIST_TIER = "Inertia enforces it: approvals are declined, commands come from a read-only allowlist, and a change to files pauses the watcher.";

const CHAT_ACCESS_NOTE = "The watcher can use its tools like a chat. Approvals appear in the watcher chat.";
const READ_ONLY_NOTE = "Reads the chat and the project's files. Can't change them.";

const TABBABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';

describe("watcher attach dialog", () => {
  it("starts on the preset group and moves through presets as roving radios", async () => {
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]));
    const group = within(dialog).getByRole("radiogroup", { name: "Preset" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Reviewer", "Scope guard", "Explainer"]);
    await waitFor(() => expect(radios[0]).toHaveFocus());
    expect(radios.map((radio) => radio.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[1]!, { key: "End" });
    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAccessibleName("Explainer");
  });

  it("labels every control and states the read-only boundary", async () => {
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]));
    expect(within(dialog).getByRole("textbox", { name: /Your instructions/u })).toHaveAttribute("maxlength", "2000");
    for (const name of [/The brief/u, /Activities/u, /Changed files/u, /Partial replies/u]) {
      expect(within(dialog).getByRole("checkbox", { name })).toBeChecked();
    }
    expect(within(dialog).getByRole("group", { name: "What the watcher sees" })).toBeInTheDocument();
    expect(within(dialog).getByRole("spinbutton", { name: /Checks per turn/u })).toHaveValue(30);
    expect(within(dialog).getByRole("spinbutton", { name: /Cooldown between checks/u })).toHaveValue(45);
    expect(within(dialog).getByRole("switch", { name: /Review the last turn now/u })).toBeDisabled();
    expect(dialog).toHaveAccessibleDescription("It reads and reports: it may run read-only commands and never edits files or changes the workspace.");
    expect(within(dialog).queryByText("What is shared with the watcher?")).not.toBeInTheDocument();
    expect(dialog.querySelectorAll("small:not([aria-hidden])")).toHaveLength(1);
  });

  it.each([
    ["running", true],
    ["completed", true],
    ["failed", false],
    ["cancelled", false],
  ] as const)("offers Review the last turn now for a %s last turn: %s", async (status, offered) => {
    const value = snapshot([ready("codex", "Codex")]);
    const watched = value.conversations[0]!;
    const latestTurn = {
      id: "watched-turn",
      runId: "watched-run",
      status,
      providerId: watched.providerId,
      harnessId: watched.modelSelection.harnessId,
      backendProfileId: watched.modelSelection.backendProfileId,
      modelSelection: watched.modelSelection,
      continuationIdentity: {
        harnessId: watched.modelSelection.harnessId,
        backendProfileId: watched.modelSelection.backendProfileId,
        backendConfigurationRevision: 1,
        modelIdentity: "fixture-model",
        endpointIdentity: null,
      },
      model: "fixture-model",
      reasoningEffort: "",
      requestedAt: "2026-10-19T10:00:00.000Z",
      startedAt: "2026-10-19T10:00:00.000Z",
      completedAt: status === "running" ? null : "2026-10-19T10:01:00.000Z",
      terminalReason: null,
      updatedAt: "2026-10-19T10:01:00.000Z",
    } as ConversationLatestTurnSummary;
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const { dialog } = await openDialog({ ...value, conversations: [{ ...watched, latestTurn }] }, { request });
    const review = within(dialog).getByRole("switch", { name: /Review the last turn now/u });
    if (!offered) {
      expect(review).toBeDisabled();
      return;
    }
    expect(review).toBeEnabled();
    fireEvent.click(review);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add watcher" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(payloadOf(request.mock.calls[0]![0])).toMatchObject({ initialReview: true });
  });

  it("keeps a logical Tab order from preset to Attach", async () => {
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]));
    const order = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)];
    const index = (element: HTMLElement) => order.indexOf(element);
    const preset = within(dialog).getByRole("radio", { name: /Reviewer/u });
    const instructions = within(dialog).getByRole("textbox", { name: /Your instructions/u });
    const brief = within(dialog).getByRole("checkbox", { name: /The brief/u });
    const budgets = within(dialog).getByText("Budgets").closest("summary")!;
    const attach = within(dialog).getByRole("button", { name: "Add watcher" });
    expect(index(preset)).toBeGreaterThan(-1);
    const access = within(dialog).getByRole("radio", { name: "Read-only" });
    expect(order.filter((element) => element.getAttribute("role") === "radio")).toEqual([preset, access]);
    expect(index(preset)).toBeLessThan(index(access));
    expect(index(access)).toBeLessThan(index(instructions));
    expect(index(instructions)).toBeLessThan(index(brief));
    expect(index(brief)).toBeLessThan(index(budgets));
    expect(index(budgets)).toBeLessThan(index(attach));
  });

  it("chooses another ready route when the watched chat's agent isn't ready", async () => {
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const onAttached = vi.fn();
    const { dialog } = await openDialog(
      snapshot([ready("cursor", "Cursor", { authState: "unauthenticated", canRun: false }), ready("codex", "Codex")], "cursor"),
      { request, onAttached },
    );
    const attach = within(dialog).getByRole("button", { name: "Add watcher" });
    expect(attach).not.toHaveAttribute("aria-disabled");
    fireEvent.click(attach);
    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(link()));
    const command = request.mock.calls[0]![0];
    expect(command.type).toBe("watcher.attach");
    expect(payloadOf(command)).toMatchObject({
      watchedConversationId: WATCHED_ID,
      preset: "reviewer",
      instructions: "",
      sharing: DEFAULT_WATCHER_SHARING,
      budgets: DEFAULT_WATCHER_BUDGETS,
      privateConnect: "inherit",
      delivery: "manual",
      initialReview: false,
      modelSelection: { harnessId: "codex-app-server" },
    });
  });

  it("offers automatic sending as a plain switch, off by default, and attaches with the chosen policy", async () => {
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request });
    const toggle = within(dialog).getByRole("switch", { name: "Send findings to the main chat automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).not.toHaveAttribute("aria-describedby");
    const sharing = within(dialog).getByRole("group", { name: "What the watcher sees" });
    expect(sharing.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add watcher" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(payloadOf(request.mock.calls[0]![0])).toMatchObject({ delivery: "auto" });
  });

  it("lists routes on every ready agent", async () => {
    const { dialog } = await openDialog(snapshot([
      ready("cursor", "Cursor"),
      ready("kimi", "Kimi Code"),
      ready("antigravity", "Antigravity"),
      ready("codex", "Codex"),
      ready("opencode", "OpenCode", { authState: "unauthenticated", canRun: false }),
    ]));
    const chooser = await openChooser(dialog);
    for (const [source, harnessId] of [["Codex", "codex-app-server"], ["Cursor", "cursor-acp"], ["Kimi Code", "kimi-acp"], ["Antigravity", "antigravity-cli"]] as const) {
      fireEvent.click(await within(chooser).findByRole("button", { name: new RegExp(`^${source}, `, "u") }));
      const rows = [...chooser.querySelectorAll<HTMLElement>("[data-model-route-key]")];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.dataset.modelRouteKey?.includes(harnessId))).toBe(true);
      expect(rows.some((row) => row.getAttribute("aria-disabled") !== "true")).toBe(true);
    }
    expect(within(chooser).queryByRole("button", { name: /^OpenCode, /u })).not.toBeInTheDocument();
  });

  it("keeps Attach disabled until a watcher route is ready", async () => {
    const { dialog } = await openDialog(snapshot([
      ready("codex", "Codex", { authState: "unauthenticated", canRun: false }),
      ready("cursor", "Cursor", { authState: "unauthenticated", canRun: false }),
    ]));
    expect(within(dialog).getByRole("button", { name: "Add watcher" })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers the watched chat's own agent when it is the only ready one", async () => {
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const { dialog } = await openDialog(snapshot([ready("cursor", "Cursor")], "cursor"), { request });
    expect(within(dialog).getByRole("button", { name: "Add watcher" })).not.toHaveAttribute("aria-disabled");
    expect(dialog.querySelector(".watcher-attach-warning")).toBeNull();
    expect(await attachPayload(dialog, request)).toMatchObject({ readOnly: true, modelSelection: { harnessId: "cursor-acp" } });
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { trigger } = await openDialog(snapshot([ready("codex", "Codex")]));
    await act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("closes when the watched chat disappears, so Escape and previews are released", async () => {
    const value = snapshot([ready("codex", "Codex")]);
    const onClose = vi.fn();
    const props = {
      settings: value.settings,
      watchedConversationId: WATCHED_ID,
      request: recordingRequest(() => ({ kind: "watcher.link", link: link() })).request,
      onClose,
      onAttached: vi.fn(),
      onOpenProviderSetup: vi.fn(),
      onOpenBackendSetup: vi.fn(),
    };
    const view = render(<WatcherAttachDialog snapshot={value} {...props} />);
    await screen.findByRole("dialog", { name: "Add a watcher" });
    view.rerender(<WatcherAttachDialog snapshot={{ ...value, conversations: [] }} {...props} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leaves Escape to the page while it closes after an attach", async () => {
    const value = snapshot([ready("codex", "Codex")]);
    const props = {
      snapshot: value,
      settings: value.settings,
      request: recordingRequest(() => ({ kind: "watcher.link", link: link() })).request,
      onClose: vi.fn(),
      onAttached: vi.fn(),
      onOpenProviderSetup: vi.fn(),
      onOpenBackendSetup: vi.fn(),
    };
    const pageEscape = vi.fn();
    const tree = (target: { watchedId: string; returnFocusTo: null } | null) => (
      <>
        <button type="button" onKeyDown={(event) => { if (event.key === "Escape") pageEscape(); }}>Pause</button>
        <WatcherAttachPresence target={target} {...props} />
      </>
    );
    const view = render(tree({ watchedId: WATCHED_ID, returnFocusTo: null }));
    await screen.findByRole("dialog", { name: "Add a watcher" });
    view.rerender(tree(null));
    expect(document.querySelector(".watcher-attach-dialog")).not.toBeNull();
    const pause = screen.getByRole("button", { name: "Pause" });
    pause.focus();
    fireEvent.keyDown(pause, { key: "Escape" });
    expect(pageEscape).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("restores a cleared budget field to its default, not its minimum", async () => {
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request });
    const checks = within(dialog).getByRole("spinbutton", { name: /Checks per turn/u });
    fireEvent.change(checks, { target: { value: "50" } });
    fireEvent.change(checks, { target: { value: "" } });
    fireEvent.blur(checks);
    expect(checks).toHaveValue(30);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add watcher" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(payloadOf(request.mock.calls[0]![0])).toMatchObject({ budgets: { wakesPerWatchedTurn: 30 } });
  });

  it("retries an ambiguous attach with the same link id and closes when the link appears", async () => {
    const recorded = recordingRequest(() => {
      throw new RuntimeCommandError("The local service did not answer in time.", "ambiguous");
    });
    const onAttached = vi.fn();
    const value = snapshot([ready("codex", "Codex")]);
    const view = render(<Harness value={value} request={recorded.request} onAttached={onAttached} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a watcher…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a watcher" });
    const attach = within(dialog).getByRole("button", { name: "Add watcher" });
    fireEvent.click(attach);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("did not answer in time");
    fireEvent.click(attach);
    await waitFor(() => expect(recorded.commands).toHaveLength(2));
    const [first, second] = recorded.commands.map((command) => payloadOf(command).linkId);
    expect(first).toEqual(second);
    expect(onAttached).not.toHaveBeenCalled();
    const created = link({ id: first as string });
    view.rerender(<Harness value={{ ...value, watchers: [created] }} request={recorded.request} onAttached={onAttached} />);
    await waitFor(() => expect(onAttached).toHaveBeenCalledWith(created));
    expect(onAttached).toHaveBeenCalledOnce();
  });

  it("keeps focus on Attach while it submits and after it fails", async () => {
    let fail: (error: Error) => void = () => undefined;
    const recorded = recordingRequest(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request: recorded.request });
    const attach = within(dialog).getByRole("button", { name: "Add watcher" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    attach.focus();
    fireEvent.click(attach);
    await waitFor(() => expect(recorded.commands).toHaveLength(1));
    expect(attach).toHaveFocus();
    expect(attach).toHaveAttribute("aria-disabled", "true");
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(cancel);
    expect(screen.getByRole("dialog", { name: "Add a watcher" })).toBeInTheDocument();
    cancel.focus();
    await act(async () => { fail(new RuntimeCommandError("This chat already has a watcher.", "rejected")); });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This chat already has a watcher.");
    expect(attach).toHaveFocus();
    expect(attach).not.toHaveAttribute("aria-disabled");
  });

  it("starts over with a new link id after a definite failure", async () => {
    const recorded = recordingRequest(() => {
      throw new RuntimeCommandError("This chat already has a watcher.", "rejected");
    });
    const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request: recorded.request });
    const attach = within(dialog).getByRole("button", { name: "Add watcher" });
    fireEvent.click(attach);
    await within(dialog).findByRole("alert");
    fireEvent.click(attach);
    await waitFor(() => expect(recorded.commands).toHaveLength(2));
    const [first, second] = recorded.commands.map((command) => payloadOf(command).linkId);
    expect(first).not.toEqual(second);
  });

  describe("access", () => {
    it("attaches read-only by default, with no mode, and says what read-only means", async () => {
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request });
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
        "Read-only",
        "Supervised",
        "Auto-accept edits",
        "Full access",
      ]);
      expect(within(group).getByRole("radio", { name: "Read-only" })).toHaveAttribute("aria-checked", "true");
      expect(group).toHaveAccessibleDescription(`${READ_ONLY_NOTE} ${INERTIA_TIER}`);
      expect(within(dialog).queryByRole("radiogroup", { name: "Mode" })).not.toBeInTheDocument();
      expect(within(dialog).queryByText(CHAT_ACCESS_NOTE)).not.toBeInTheDocument();
      const payload = await attachPayload(dialog, request);
      expect(payload).toMatchObject({ readOnly: true });
      expect(payload).not.toHaveProperty("interactionMode");
      expect(payload).not.toHaveProperty("accessMode");
    });

    it.each([
      ["Supervised", "supervised"],
      ["Auto-accept edits", "auto-edit"],
      ["Full access", "full"],
    ] as const)("reveals Mode for %s and attaches with chat access", async (label, accessMode) => {
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request });
      fireEvent.click(within(dialog).getByRole("radio", { name: label }));
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      expect(group).toHaveAccessibleDescription(CHAT_ACCESS_NOTE);
      expect(dialog).not.toHaveAccessibleDescription(/never edits files/u);
      const mode = within(dialog).getByRole("radiogroup", { name: "Mode" });
      expect(within(mode).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Build", "Plan"]);
      expect(within(mode).getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(within(mode).getByRole("radio", { name: "Plan" }));
      expect(await attachPayload(dialog, request)).toMatchObject({ readOnly: false, interactionMode: "plan", accessMode });
    });

    it("hides Mode again and drops the mode fields when Read-only is chosen back", async () => {
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]), { request });
      fireEvent.click(within(dialog).getByRole("radio", { name: "Full access" }));
      expect(within(dialog).getByRole("radiogroup", { name: "Mode" })).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("radio", { name: "Read-only" }));
      expect(within(dialog).queryByRole("radiogroup", { name: "Mode" })).not.toBeInTheDocument();
      expect(dialog).toHaveAccessibleDescription(/never edits files/u);
      const payload = await attachPayload(dialog, request);
      expect(payload).toMatchObject({ readOnly: true });
      expect(payload).not.toHaveProperty("interactionMode");
      expect(payload).not.toHaveProperty("accessMode");
    });

    it("moves through access levels with the arrow keys as one tab stop", async () => {
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]));
      const radios = within(within(dialog).getByRole("radiogroup", { name: "Access" })).getAllByRole("radio");
      expect(radios.map((radio) => radio.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
      radios[0]!.focus();
      fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
      expect(radios[1]).toHaveFocus();
      expect(radios[1]).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(radios[1]!, { key: "End" });
      expect(radios[3]).toHaveFocus();
      expect(radios[3]).toHaveAccessibleName("Full access");
      expect(radios.map((radio) => radio.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", "0"]);
      const mode = within(within(dialog).getByRole("radiogroup", { name: "Mode" })).getAllByRole("radio");
      mode[0]!.focus();
      fireEvent.keyDown(mode[0]!, { key: "ArrowLeft" });
      expect(mode[1]).toHaveFocus();
      expect(mode[1]).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(radios[3]!, { key: "Home" });
      expect(radios[0]).toHaveFocus();
      expect(within(dialog).queryByRole("radiogroup", { name: "Mode" })).not.toBeInTheDocument();
    });

    it("says why Supervised can't pause for approval on a route that can't supervise", async () => {
      const { dialog } = await openDialog(snapshot([ready("antigravity", "Antigravity")], "antigravity"));
      fireEvent.click(within(dialog).getByRole("radio", { name: "Supervised" }));
      expect(within(dialog).getByRole("radiogroup", { name: "Access" })).toHaveAccessibleDescription(
        expect.stringContaining("can't pause for approval"),
      );
      fireEvent.click(within(dialog).getByRole("radio", { name: "Full access" }));
      expect(within(dialog).queryByText(/can't pause for approval/u)).not.toBeInTheDocument();
    });
  });

  describe("read-only tiers", () => {
    it.each([
      ["codex", "Codex", INERTIA_TIER],
      ["claude", "Claude Code", ALLOWLIST_TIER],
      ["opencode", "OpenCode", ALLOWLIST_TIER],
      ["cursor", "Cursor", "Inertia declines what Cursor reports and pauses the watcher if files change. Cursor controls its own reads and commands; there is no sandbox."],
      ["kimi", "Kimi Code", "Inertia declines what Kimi Code reports and pauses the watcher if files change. Kimi Code controls its own reads and commands; there is no sandbox."],
      ["antigravity", "Antigravity", "Antigravity runs in its own plan mode. Inertia can't decline its actions; it stops a check after an edit it sees and pauses the watcher if files change. It can't read more of the main chat."],
    ] as const)("states how %s keeps a watcher read-only", async (providerId, label, statement) => {
      const { dialog } = await openDialog(snapshot([ready(providerId, label)], providerId));
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      expect(within(group).getByRole("radio", { name: "Read-only" })).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("radio", { name: "Read-only" })).toBeEnabled();
      expect(group).toHaveAccessibleDescription(`${READ_ONLY_NOTE} ${statement}`);
      if (statement === INERTIA_TIER || statement === ALLOWLIST_TIER) expect(dialog).toHaveAccessibleDescription(/never edits files/u);
      else expect(dialog).not.toHaveAccessibleDescription(/never edits files/u);
    });

    it("updates the statement when the route moves to another agent", async () => {
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex"), ready("cursor", "Cursor")]));
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      expect(group).toHaveAccessibleDescription(`${READ_ONLY_NOTE} ${INERTIA_TIER}`);
      await chooseRoute(dialog, "Cursor", "cursor-acp");
      expect(group).toHaveAccessibleDescription(expect.stringContaining("Inertia declines what Cursor reports"));
    });

    it("starts an agent without a read-only tier on Plan and Supervised, with Read-only unavailable", async () => {
      tiers.withoutReadOnly.add("kimi-acp");
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([ready("kimi", "Kimi Code")], "kimi"), { request });
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      const readOnly = within(group).getByRole("radio", { name: "Read-only" });
      expect(readOnly).toBeDisabled();
      expect(readOnly).toHaveAttribute("aria-checked", "false");
      expect(readOnly).toHaveAttribute("tabindex", "-1");
      expect(within(group).getByRole("radio", { name: "Supervised" })).toHaveAttribute("aria-checked", "true");
      expect(within(group).getByRole("radio", { name: "Supervised" })).toHaveAttribute("tabindex", "0");
      expect(group).toHaveAccessibleDescription(`Read-only isn't available on this agent. ${CHAT_ACCESS_NOTE}`);
      expect(within(dialog).getByRole("radio", { name: "Plan" })).toHaveAttribute("aria-checked", "true");
      const supervised = within(group).getByRole("radio", { name: "Supervised" });
      supervised.focus();
      fireEvent.keyDown(supervised, { key: "Home" });
      expect(within(group).getByRole("radio", { name: "Supervised" })).toHaveFocus();
      fireEvent.keyDown(supervised, { key: "ArrowLeft" });
      expect(within(group).getByRole("radio", { name: "Full access" })).toHaveFocus();
      fireEvent.keyDown(within(group).getByRole("radio", { name: "Full access" }), { key: "ArrowRight" });
      expect(supervised).toHaveFocus();
      expect(await attachPayload(dialog, request)).toMatchObject({ readOnly: false, interactionMode: "plan", accessMode: "supervised" });
    });

    it("switches to Plan and Supervised when the route moves to an agent without a read-only tier", async () => {
      tiers.withoutReadOnly.add("kimi-acp");
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex"), ready("kimi", "Kimi Code")]), { request });
      const group = within(dialog).getByRole("radiogroup", { name: "Access" });
      expect(within(group).getByRole("radio", { name: "Read-only" })).toHaveAttribute("aria-checked", "true");
      await chooseRoute(dialog, "Kimi Code", "kimi-acp");
      const focused = document.activeElement;
      expect(within(group).getByRole("radio", { name: "Read-only" })).toBeDisabled();
      expect(within(group).getByRole("radio", { name: "Supervised" })).toHaveAttribute("aria-checked", "true");
      expect(within(dialog).getByRole("radio", { name: "Plan" })).toHaveAttribute("aria-checked", "true");
      expect(document.activeElement).toBe(focused);
      expect(await attachPayload(dialog, request)).toMatchObject({
        readOnly: false,
        interactionMode: "plan",
        accessMode: "supervised",
        modelSelection: { harnessId: "kimi-acp" },
      });
    });

    it("keeps a chosen chat access when the route moves to an agent without a read-only tier", async () => {
      tiers.withoutReadOnly.add("kimi-acp");
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex"), ready("kimi", "Kimi Code")]));
      fireEvent.click(within(dialog).getByRole("radio", { name: "Full access" }));
      await chooseRoute(dialog, "Kimi Code", "kimi-acp");
      expect(within(dialog).getByRole("radio", { name: "Full access" })).toHaveAttribute("aria-checked", "true");
      expect(within(dialog).getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "true");
    });
  });

  describe("reasoning and speed", () => {
    it("hides Reasoning and Speed for a route without those choices", async () => {
      const { dialog } = await openDialog(snapshot([ready("codex", "Codex")]));
      expect(within(dialog).queryByRole("radiogroup", { name: "Reasoning" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("radiogroup", { name: "Speed" })).not.toBeInTheDocument();
    });

    it("offers the route's reasoning levels and speed and attaches them in the model selection", async () => {
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([tunable("codex", "Codex")]), { request });
      const reasoning = within(dialog).getByRole("radiogroup", { name: "Reasoning" });
      expect(within(reasoning).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
        "Low",
        "Medium · Default",
        "High",
      ]);
      expect(within(reasoning).getByRole("radio", { name: "Medium · Default" })).toHaveAttribute("aria-checked", "true");
      const speed = within(dialog).getByRole("radiogroup", { name: "Speed" });
      expect(within(speed).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Standard", "Fast"]);
      expect(within(speed).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
      const high = within(reasoning).getByRole("radio", { name: "High" });
      high.focus();
      fireEvent.keyDown(high, { key: "ArrowLeft" });
      expect(within(reasoning).getByRole("radio", { name: "Medium · Default" })).toHaveFocus();
      fireEvent.click(high);
      fireEvent.click(within(speed).getByRole("radio", { name: "Fast" }));
      expect(within(speed).getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
      expect(await attachPayload(dialog, request)).toMatchObject({
        modelSelection: { harnessId: "codex-app-server", reasoningEffort: "high", providerOptions: { fastMode: "priority" } },
      });
    });

    it("drops Fast when Standard is chosen again", async () => {
      const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
      const { dialog } = await openDialog(snapshot([tunable("codex", "Codex")]), { request });
      const speed = within(dialog).getByRole("radiogroup", { name: "Speed" });
      fireEvent.click(within(speed).getByRole("radio", { name: "Fast" }));
      fireEvent.click(within(speed).getByRole("radio", { name: "Standard" }));
      const payload = await attachPayload(dialog, request);
      expect((payload.modelSelection as { providerOptions: Record<string, unknown> }).providerOptions).not.toHaveProperty("fastMode");
    });
  });

  function storeFullAccessFavorite(): void {
    window.localStorage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({
      version: 2,
      favorites: [{
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        modelId: "fixture-model",
        reasoningEffort: "high",
        configuration: { accessMode: "full", interactionMode: "plan", fastMode: true },
      }],
    }));
  }

  async function chooseFullAccessFavorite(dialog: HTMLElement): Promise<void> {
    const chooser = await openChooser(dialog);
    const favorite = [...chooser.querySelectorAll<HTMLElement>("[data-model-route-key]")]
      .find((row) => row.textContent?.includes("Full access"));
    expect(favorite).toBeDefined();
    fireEvent.click(favorite!.closest("button") ?? favorite!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument());
  }

  const liveRegion = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>('p.visually-hidden[role="status"]')!;

  it("says when the access came from a favorite and announces it", async () => {
    storeFullAccessFavorite();
    const { dialog } = await openDialog(snapshot([tunable("codex", "Codex")]));
    const group = within(dialog).getByRole("radiogroup", { name: "Access" });
    expect(within(dialog).queryByText("Set from the favorite.")).not.toBeInTheDocument();
    expect(liveRegion(dialog)).toHaveAttribute("aria-live", "polite");
    expect(liveRegion(dialog)).toBeEmptyDOMElement();
    await chooseFullAccessFavorite(dialog);
    expect(within(group).getByRole("radio", { name: "Full access" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("Set from the favorite.")).toBeInTheDocument();
    expect(group).toHaveAccessibleDescription(`${CHAT_ACCESS_NOTE} Set from the favorite.`);
    expect(liveRegion(dialog)).toHaveTextContent(/^Access set to Full access from the favorite\.?$/u);
    fireEvent.click(within(group).getByRole("radio", { name: "Supervised" }));
    expect(within(dialog).queryByText("Set from the favorite.")).not.toBeInTheDocument();
    expect(group).toHaveAccessibleDescription(CHAT_ACCESS_NOTE);
  });

  it("drops the favorite note when access is changed from the keyboard", async () => {
    storeFullAccessFavorite();
    const { dialog } = await openDialog(snapshot([tunable("codex", "Codex")]));
    await chooseFullAccessFavorite(dialog);
    const full = within(dialog).getByRole("radio", { name: "Full access" });
    full.focus();
    fireEvent.keyDown(full, { key: "ArrowLeft" });
    expect(within(dialog).getByRole("radio", { name: "Auto-accept edits" })).toHaveFocus();
    expect(within(dialog).queryByText("Set from the favorite.")).not.toBeInTheDocument();
  });

  it("applies a favorite's access, mode and speed when it is chosen", async () => {
    window.localStorage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({
      version: 2,
      favorites: [{
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        modelId: "fixture-model",
        reasoningEffort: "high",
        configuration: { accessMode: "full", interactionMode: "plan", fastMode: true },
      }],
    }));
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const { dialog } = await openDialog(snapshot([tunable("codex", "Codex")]), { request });
    const section = within(dialog).getByRole("heading", { name: "Model route" }).closest("section")!;
    fireEvent.click(section.querySelector<HTMLButtonElement>("button[aria-controls]")!);
    const chooser = await screen.findByRole("dialog", { name: "Choose model" });
    const favorite = [...chooser.querySelectorAll<HTMLElement>("[data-model-route-key]")]
      .find((row) => row.textContent?.includes("Full access"));
    expect(favorite).toBeDefined();
    fireEvent.click(favorite!.closest("button") ?? favorite!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument());
    expect(within(dialog).getByRole("radio", { name: "Full access" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("radio", { name: "Plan" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("radio", { name: "High" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
    expect(await attachPayload(dialog, request)).toMatchObject({
      readOnly: false,
      interactionMode: "plan",
      accessMode: "full",
      modelSelection: { reasoningEffort: "high", providerOptions: { fastMode: "priority" } },
    });
  });
});
