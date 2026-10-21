import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AppSnapshot, ConversationLatestTurnSummary, ProviderId, ProviderInfo } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { DEFAULT_WATCHER_BUDGETS, DEFAULT_WATCHER_SHARING, type WatcherLinkView } from "../../src/shared/watcher";
import { WatcherAttachDialog, WatcherAttachPresence } from "../../src/renderer/src/components/watcher/WatcherAttachDialog";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { WATCHED_ID, link, payloadOf, project, recordingRequest, shell } from "./watcher-fixtures";

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

const TABBABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]';

describe("WatcherAttachDialog", () => {
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
    expect(order.filter((element) => element.getAttribute("role") === "radio")).toEqual([preset]);
    expect(index(preset)).toBeLessThan(index(instructions));
    expect(index(instructions)).toBeLessThan(index(brief));
    expect(index(brief)).toBeLessThan(index(budgets));
    expect(index(budgets)).toBeLessThan(index(attach));
  });

  it("chooses a ready watcher route even when the watched chat runs elsewhere", async () => {
    const request = recordingRequest(() => ({ kind: "watcher.link", link: link() })).request;
    const onAttached = vi.fn();
    const { dialog } = await openDialog(
      snapshot([ready("cursor", "Cursor"), ready("codex", "Codex")], "cursor"),
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

  it("lists only routes on agents that can watch, and only ready ones are selectable", async () => {
    const { dialog } = await openDialog(snapshot([
      ready("cursor", "Cursor"),
      ready("codex", "Codex"),
      ready("opencode", "OpenCode", { authState: "unauthenticated", canRun: false }),
    ]));
    const section = within(dialog).getByRole("heading", { name: "Model route" }).closest("section")!;
    fireEvent.click(section.querySelector<HTMLButtonElement>("button[aria-controls]")!);
    const chooser = await screen.findByRole("dialog", { name: "Choose model" });
    const rows = [...chooser.querySelectorAll<HTMLElement>("[data-model-route-key]")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.dataset.modelRouteKey?.includes("cursor"))).toBe(false);
    for (const row of rows) {
      const key = row.dataset.modelRouteKey ?? "";
      expect(key.includes("codex-app-server") || key.includes("opencode-sdk")).toBe(true);
      if (key.includes("opencode-sdk")) expect(row).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("keeps Attach disabled until a watcher route is ready", async () => {
    const { dialog } = await openDialog(snapshot([
      ready("codex", "Codex", { authState: "unauthenticated", canRun: false }),
      ready("cursor", "Cursor"),
    ]));
    expect(within(dialog).getByRole("button", { name: "Add watcher" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("status")).not.toHaveTextContent(/Cursor/u);
  });

  it("offers no route when only agents that cannot watch are ready", async () => {
    const { dialog } = await openDialog(snapshot([ready("cursor", "Cursor")], "cursor"));
    expect(within(dialog).getByRole("button", { name: "Add watcher" })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("status")).toHaveTextContent("No watcher route");
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
});
