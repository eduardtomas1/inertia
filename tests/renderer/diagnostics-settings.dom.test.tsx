import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSettings } from "../../src/renderer/src/components/DiagnosticsSettings";
import { DIAGNOSTIC_NAVIGATION_EVENT } from "../../src/renderer/src/utils/diagnosticNavigation";
import {
  compareDiagnosticEntries,
  diagnosticDefinition,
  diagnosticEventMatches,
  diagnosticMatches,
  diagnosticQuerySchema,
  type DiagnosticEventEntry,
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticRecord,
} from "../../src/shared/application-diagnostics";
import type { Conversation, Project, ProviderInfo } from "../../src/shared/contracts";
import type { AppHealthSnapshot } from "../../src/shared/desktop";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = { id: id(100), name: "Release sandbox" } as Project;
const conversation = { id: id(101), title: "Investigate delivery" } as Conversation;
function record(n: number, code: DiagnosticRecord["code"] = "discord.delivery-unknown"): DiagnosticRecord {
  const definition = diagnosticDefinition(code);
  return { schemaVersion: 1, id: id(n), correlationId: id(n + 200), code,
    severity: definition.severity, subsystem: definition.subsystem, operation: definition.operation,
    at: new Date(Date.UTC(2026, 8, 9, 8, 0, n)).toISOString(), firstAt: "2026-09-09T08:00:00.000Z",
    outcome: "unknown", runtimeGeneration: null, occurrences: 1,
    context: { projectId: project.id, conversationId: conversation.id, providerId: "claude" }, metadata: {},
  };
}
function event(n: number, update: Partial<DiagnosticEventEntry> = {}): DiagnosticEventEntry {
  return { id: `event-${String(n).padStart(16, "0")}`, at: new Date(Date.UTC(2026, 8, 9, 8, 0, n)).toISOString(),
    event: "app.start", severity: "info", subsystem: "application", title: "Inertia started", detail: [], ...update };
}
const health: AppHealthSnapshot = {
  sampledAt: "2026-09-09T08:01:00.000Z", totalMemoryBytes: 420 * 1_024 * 1_024,
  mainProcess: { pid: 1, cpuPercent: 1.25, memoryBytes: 120 * 1_024 * 1_024 },
  rendererProcesses: [{ pid: 2, cpuPercent: 0, memoryBytes: 200 * 1_024 * 1_024 }],
  runtimeProcess: { pid: 3, cpuPercent: 0, memoryBytes: 92 * 1_024 * 1_024 }, runtimePhase: "ready",
  databaseBytes: 1_024, cacheBytes: 1_024, temporaryAttachmentBytes: 0, warnings: [],
};
const settle = async (): Promise<void> => { await act(() => vi.advanceTimersByTimeAsync(250)); };
afterEach(() => { Reflect.deleteProperty(window, "inertia"); vi.useRealTimers(); });

function setup(records: DiagnosticRecord[], events: DiagnosticEventEntry[] = [], overrides: Partial<DiagnosticPage> = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T08:01:00Z"));
  let listener = (): void => undefined;
  const unsubscribe = vi.fn();
  let capture = { enabled: true, since: null as string | null };
  const queryDiagnostics = vi.fn(async (query: DiagnosticQuery): Promise<DiagnosticPage> => {
    const filter = diagnosticQuerySchema.parse(query);
    const matching = [
      ...records.filter((item) => diagnosticMatches(item, filter)).map((item) => ({ at: item.at, id: item.id, item, kind: "record" as const })),
      ...events.filter((item) => diagnosticEventMatches(item, filter)).map((item) => ({ at: item.at, id: item.id, item, kind: "event" as const })),
    ].sort(compareDiagnosticEntries);
    const window = matching.slice(filter.offset, filter.offset + filter.limit);
    return { records: window.flatMap((entry) => entry.kind === "record" ? [entry.item] : []),
      events: window.flatMap((entry) => entry.kind === "event" ? [entry.item] : []),
      capture: capture.enabled, since: capture.since, total: matching.length,
      nextOffset: filter.offset + filter.limit < matching.length ? filter.offset + filter.limit : null,
      persistence: "available", runtime: "unavailable", dropped: 0, revision: 1, currentIncidentIds: [],
      facets: { projectIds: [project.id], providerIds: ["claude"] }, ...overrides };
  });
  const setDiagnosticsCapture = vi.fn(async (enabled: boolean) => {
    capture = { enabled, since: "2026-09-09T08:00:30.000Z" };
    return capture;
  });
  const clearDiagnostics = vi.fn(async () => ({ cleared: true as const }));
  const copyDiagnostics = vi.fn(async () => ({ copied: true, count: 1 }));
  const exportDiagnostics = vi.fn(async (): Promise<{ status: "exported" | "cancelled" }> => ({ status: "exported" }));
  const getAppHealth = vi.fn(async () => health);
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    queryDiagnostics, copyDiagnostics, exportDiagnostics, setDiagnosticsCapture, clearDiagnostics, getAppHealth,
    onDiagnosticsChanged: (callback: () => void) => { listener = callback; return unsubscribe; },
  } });
  const onRevealRuntimeLogs = vi.fn(async () => "");
  const onCopyRuntimeDiagnosticReport = vi.fn(async () => ({ copied: true, eventCount: 3 }));
  const props = { projects: [project], conversations: [conversation], providers: [{ id: "claude", label: "Claude" } as ProviderInfo],
    appUpdateStatus: null, onRevealRuntimeLogs, onCopyRuntimeDiagnosticReport };
  const view = render(<DiagnosticsSettings {...props} />);
  return { ...view, queryDiagnostics, copyDiagnostics, exportDiagnostics, setDiagnosticsCapture, clearDiagnostics, getAppHealth,
    onRevealRuntimeLogs, onCopyRuntimeDiagnosticReport, unsubscribe, publish: () => listener(), props };
}

const rows = (): HTMLElement[] => within(screen.getByRole("list", { name: "Recent events" })).getAllByRole("button", { expanded: false });

describe("Diagnostics settings", () => {
  it("lists lifecycle events and incidents together, newest first, as plain expandable rows", async () => {
    setup([record(2)], [event(1), event(3, { event: "runtime.failure", severity: "error", subsystem: "runtime",
      title: "The local runtime reported a failure", detail: ["phase=restarting", "Runtime startup timed out."] })]);
    await settle();
    expect(screen.getByRole("heading", { name: "Diagnostics", level: 3 })).toBeVisible();
    expect(screen.getByText("Events and failures recorded on this device.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent events", level: 3 })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    expect(rows()[0]!.querySelector("time")).toHaveTextContent("Sep 9, 8:00:03 AM");
    expect(rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([
      "The local runtime reported a failure", "Discord delivery could not be confirmed", "Inertia started",
    ]);
    expect(rows()[0]).toHaveTextContent("Runtime · Error");
    expect(rows()[1]).toHaveTextContent("Discord · Claude · Release sandbox · Warning");
    expect(document.querySelector(".diagnostics-outcome")).toBeNull();
    fireEvent.click(rows()[0]!);
    expect(screen.getByRole("button", { name: /The local runtime reported a failure/u })).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("region", { name: "Event details" });
    expect(details).toHaveTextContent("phase=restarting");
    expect(details).toHaveAttribute("tabindex", "0");
  });

  it("expands an incident to its explanation, facts and actions, copies it, and never opens offline work", async () => {
    const incident = record(1);
    const h = setup([incident]);
    await settle();
    const row = rows()[0]!;
    row.focus();
    expect(row).toHaveFocus();
    fireEvent.click(row);
    expect(screen.getByText(/message may already have arrived/u)).toBeVisible();
    expect(screen.getByText("Outcome unknown")).toBeVisible();
    expect(screen.getByText(incident.correlationId)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open affected conversation" })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy incident" })));
    expect(h.copyDiagnostics).toHaveBeenCalledExactlyOnceWith({ incidentId: incident.id, severity: "all" });
    expect(screen.getByRole("status")).toHaveTextContent("Incident copied.");
    const navigation = vi.fn();
    window.addEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigation);
    fireEvent.click(screen.getByRole("button", { name: "Open Discord settings" }));
    window.removeEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigation);
    expect((navigation.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "discord" });
  });

  it("filters by level, source, time and search and pages a bounded list", async () => {
    const h = setup(Array.from({ length: 30 }, (_, n) => record(n + 1)));
    await settle();
    expect(h.queryDiagnostics).toHaveBeenLastCalledWith({ severity: "all", offset: 0 });
    expect(rows()).toHaveLength(25);
    let release = (): void => undefined;
    const slow = h.queryDiagnostics.getMockImplementation()!;
    h.queryDiagnostics.mockImplementationOnce((query) => new Promise((resolve) => { release = () => resolve(slow(query)); }));
    const next = screen.getByRole("button", { name: "Next" });
    next.focus();
    fireEvent.click(next); await settle();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).not.toBeDisabled();
    expect(next).toHaveFocus();
    const calls = h.queryDiagnostics.mock.calls.length;
    fireEvent.click(next); await settle();
    expect(h.queryDiagnostics.mock.calls.length).toBe(calls);
    await act(async () => release());
    await settle();
    expect(rows()).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Previous" })); await settle();
    const cutoff = new Date(Date.now() - 3_600_000).toISOString();
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "warning" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "discord" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "3600000" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search diagnostics" }), { target: { value: "delivery" } });
    await settle();
    expect(h.queryDiagnostics).toHaveBeenLastCalledWith({ offset: 0, severity: "warning", subsystem: "discord", after: cutoff, search: "delivery" });
    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(screen.queryByLabelText("Project")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search diagnostics" }), { target: { value: "unmatched" } });
    await settle();
    expect(screen.getByText("No events match these filters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  });

  it("turns capture off and on, explaining what is still kept, and ignores repeat clicks while saving", async () => {
    const h = setup([], [event(1)]);
    await settle();
    const toggle = screen.getByRole("switch", { name: "Capture diagnostics" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    toggle.focus();
    let release = (): void => undefined;
    const save = h.setDiagnosticsCapture.getMockImplementation()!;
    h.setDiagnosticsCapture.mockImplementationOnce((enabled) => new Promise((resolve) => { release = () => resolve(save(enabled)); }));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    await act(async () => release());
    await settle();
    expect(h.setDiagnosticsCapture).toHaveBeenCalledExactlyOnceWith(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByText(/Off since/u)).toHaveTextContent("App start, quit and failures are still kept.");
    h.setDiagnosticsCapture.mockRejectedValueOnce(new Error("Diagnostics settings could not be saved."));
    await act(async () => fireEvent.click(toggle));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("Capture could not be changed. Try again.");
  });

  it("runs the header actions and reports each result once", async () => {
    const h = setup([record(1)]);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy support summary" })));
    expect(h.onCopyRuntimeDiagnosticReport).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Support summary copied · 3 events.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reveal log folder" })));
    expect(h.onRevealRuntimeLogs).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Log folder opened.");
    h.exportDiagnostics.mockResolvedValueOnce({ status: "cancelled" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(h.exportDiagnostics).toHaveBeenLastCalledWith({ severity: "all", offset: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Export cancelled.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(screen.getByRole("status")).toHaveTextContent("Diagnostics exported.");
    let release = (): void => undefined;
    h.onCopyRuntimeDiagnosticReport.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ copied: true, eventCount: 1 });
    }));
    const copy = screen.getByRole("button", { name: "Copy support summary" });
    copy.focus();
    fireEvent.click(copy);
    expect(copy).toHaveTextContent("Copying…");
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).toHaveFocus();
    fireEvent.click(copy);
    await act(async () => release());
    expect(h.onCopyRuntimeDiagnosticReport).toHaveBeenCalledTimes(2);
    expect(copy).toHaveTextContent("Copy support summary");
    expect(screen.getByRole("status")).toHaveTextContent("Support summary copied · 1 event.");
  });

  it("keeps the dialog open and says so when Clear history fails", async () => {
    const h = setup([record(1)]);
    await settle();
    h.clearDiagnostics.mockRejectedValueOnce(new Error("Diagnostics history could not be cleared."));
    fireEvent.click(screen.getByRole("button", { name: "Clear history…" }));
    const dialog = screen.getByRole("dialog", { name: "Clear diagnostics history?" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" })));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The history could not be cleared. Try again.");
    expect(screen.getByText("Discord delivery could not be confirmed")).toBeVisible();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" })));
    expect(h.clearDiagnostics).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms Clear history in a dialog that starts on Cancel and returns focus to the trigger", async () => {
    const h = setup([record(1)]);
    await settle();
    const trigger = screen.getByRole("button", { name: "Clear history…" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Clear diagnostics history?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(h.clearDiagnostics).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear history" })));
    expect(h.clearDiagnostics).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Diagnostics history cleared.");
  });

  it("shows sampled process health as a usage line and a state line", async () => {
    setup([]);
    await settle();
    const block = screen.getByRole("group", { name: "Process health" });
    expect(within(block).getByText("Memory 420 MB · Main 120 MB, 1.3% CPU · Interface 200 MB · Local service 92 MB")).toBeVisible();
    expect(within(block).getByText("Local service ready · Measured Sep 9, 8:01:00 AM")).toBeVisible();
  });

  it("calls a stopped or idle local service offline", async () => {
    const h = setup([]);
    h.getAppHealth.mockResolvedValue({ ...health, runtimePhase: "idle", runtimeProcess: null });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    const block = screen.getByRole("group", { name: "Process health" });
    expect(block).toHaveTextContent("Local service unavailable");
    expect(block).toHaveTextContent("Local service offline");
  });

  it("opens a linked operation with one Show all link and explains a missing one", async () => {
    const incident = { ...record(1, "turn.inactivity"), outcome: "observing" as const };
    const h = setup([incident], [], { runtime: "ready" });
    await settle();
    h.rerender(<DiagnosticsSettings {...h.props} conversations={[]} projects={[]} selection={{ incidentId: incident.id }} />);
    await settle();
    expect(h.queryDiagnostics).toHaveBeenLastCalledWith({ incidentId: incident.id, severity: "all", offset: 0 });
    expect(screen.getByRole("button", { name: /The provider inactivity|No recent provider activity/u })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Unavailable or deleted conversation")).toBeVisible();
    expect(screen.queryByText("Show all incidents")).toBeNull();
    h.rerender(<DiagnosticsSettings {...h.props} selection={{ incidentId: id(999) }} />);
    await settle();
    expect(screen.getByText("This event is no longer in the retained history.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await settle();
    expect(h.queryDiagnostics.mock.calls.at(-1)![0]).not.toHaveProperty("incidentId");
  });

  it("says when capture was off for a linked operation that was never recorded", async () => {
    const h = setup([], [], { capture: false, since: "2026-09-09T07:00:00.000Z" });
    await settle();
    h.rerender(<DiagnosticsSettings {...h.props} selection={{ turnId: id(5) }} />);
    await settle();
    expect(screen.getByText("Diagnostics capture is off, so this was not recorded.")).toBeVisible();
  });

  it("expands a linked row once and keeps it collapsed after the user collapses it", async () => {
    const incident = { ...record(1), context: { ...record(1).context, turnId: id(5) } };
    const h = setup([incident]);
    await settle();
    h.rerender(<DiagnosticsSettings {...h.props} selection={{ turnId: id(5) }} />);
    await settle();
    const row = screen.getByRole("button", { name: /Discord delivery/u });
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    h.publish();
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(screen.getByRole("button", { name: /Discord delivery/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("explains a failed first read quietly, keeps capture unknown, and retries on request", async () => {
    const h = setup([record(1)]);
    const answer = h.queryDiagnostics.getMockImplementation()!;
    h.queryDiagnostics.mockReset();
    h.queryDiagnostics.mockRejectedValueOnce(new Error("offline"));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Diagnostics could not be read.")).toBeVisible();
    const toggle = screen.getByRole("switch", { name: "Capture diagnostics" });
    expect(toggle).not.toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    h.queryDiagnostics.mockRejectedValueOnce(new Error("offline"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Diagnostics could not be read.");
    h.queryDiagnostics.mockImplementation(answer);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await settle();
    expect(screen.queryByText("Diagnostics could not be read.")).toBeNull();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(rows()).toHaveLength(1);
  });

  it("coalesces change notifications and reports disk failure plainly", async () => {
    const h = setup([record(1)], [], { persistence: "unavailable", dropped: 2 });
    await settle();
    expect(screen.getByText("Diagnostics cannot be saved to disk right now. New events are kept until you quit.")).toBeVisible();
    expect(screen.getByText("2 events could not be saved.")).toBeVisible();
    for (let n = 0; n < 50; n++) h.publish();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(h.queryDiagnostics).toHaveBeenCalledTimes(2);
    h.unmount();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
