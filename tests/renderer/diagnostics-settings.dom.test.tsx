import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsSettings } from "../../src/renderer/src/components/DiagnosticsSettings";
import { DIAGNOSTIC_NAVIGATION_EVENT } from "../../src/renderer/src/utils/diagnosticNavigation";
import { diagnosticDefinition, diagnosticMatches, diagnosticQuerySchema, type DiagnosticPage, type DiagnosticQuery, type DiagnosticRecord } from "../../src/shared/application-diagnostics";
import type { Conversation, Project, ProviderInfo } from "../../src/shared/contracts";

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
const settle = async (): Promise<void> => { await act(() => vi.advanceTimersByTimeAsync(250)); };
afterEach(() => { Reflect.deleteProperty(window, "inertia"); vi.useRealTimers(); });

function setup(records: DiagnosticRecord[], overrides: Partial<DiagnosticPage> = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T08:01:00Z"));
  let listener = (): void => undefined;
  const unsubscribe = vi.fn();
  const queryDiagnostics = vi.fn(async (query: DiagnosticQuery): Promise<DiagnosticPage> => {
    const filter = diagnosticQuerySchema.parse(query);
    const matching = records.filter((item) => diagnosticMatches(item, filter));
    return { records: matching.slice(filter.offset, filter.offset + filter.limit), total: matching.length,
      nextOffset: filter.offset + filter.limit < matching.length ? filter.offset + filter.limit : null,
      persistence: "available", runtime: "unavailable", dropped: 0, revision: 1, currentIncidentIds: [],
      facets: { projectIds: [project.id], providerIds: ["claude"] }, ...overrides };
  });
  const copyDiagnostics = vi.fn(async () => ({ copied: true, count: 1 }));
  const exportDiagnostics = vi.fn(async (): Promise<{ status: "exported" | "cancelled" }> => ({ status: "exported" }));
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    queryDiagnostics, copyDiagnostics, exportDiagnostics,
    onDiagnosticsChanged: (callback: () => void) => { listener = callback; return unsubscribe; },
  } });
  const props = { projects: [project], conversations: [conversation], providers: [{ id: "claude", label: "Claude" } as ProviderInfo] };
  return { ...render(<DiagnosticsSettings {...props} />), queryDiagnostics, copyDiagnostics, exportDiagnostics, unsubscribe, publish: () => listener(), props };
}

describe("Diagnostics settings", () => {
  it("distinguishes a current provider readiness failure from historical terminal work", async () => {
    const incident = { ...record(1, "provider.connection-failed"), outcome: "failed" as const, context: { providerId: "claude" as const } };
    setup([incident], { runtime: "ready", currentIncidentIds: [incident.id] }); await settle();
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(screen.queryByText("Historical failure")).toBeNull();
  });
  it("reads warnings/errors offline, expands text details, copies the exact incident, and never tries to open offline work", async () => {
    const incident = record(1);
    const h = setup([incident, record(2, "runtime.reconnected")]); await settle();
    expect(h.queryDiagnostics).toHaveBeenLastCalledWith({ severity: "attention", offset: 0 });
    expect(screen.getByText("1 matching incident")).toBeVisible();
    expect(screen.getByText("Runtime offline · diagnostics available")).toBeVisible();
    const summary = screen.getByText("Discord delivery could not be confirmed").closest("summary")!;
    summary.focus(); expect(summary).toHaveFocus(); fireEvent.click(summary);
    expect(screen.getByText(/message may already have arrived/u)).toBeVisible();
    expect(screen.getByText("Outcome unknown")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open affected conversation" })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy incident" })));
    expect(h.copyDiagnostics).toHaveBeenCalledExactlyOnceWith({ incidentId: incident.id, severity: "all" });
    expect(screen.getByRole("status")).toHaveTextContent("Private context identifiers");
    h.exportDiagnostics.mockResolvedValueOnce({ status: "cancelled" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export filtered" })));
    expect(screen.getByRole("status")).toHaveTextContent("Export cancelled. No file was saved.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export filtered" })));
    expect(screen.getByRole("status")).toHaveTextContent("Filtered diagnostics saved");
    h.unmount(); expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("applies search, severity, subsystem, provider, project and time filters and paginates a bounded list", async () => {
    const h = setup(Array.from({ length: 30 }, (_, n) => record(n + 1))); await settle();
    expect(document.querySelectorAll("details")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Next" })); await settle();
    expect(document.querySelectorAll("details")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Previous" })); await settle();
    const expectedCutoff = new Date(Date.now() - 3_600_000).toISOString();
    for (const [label, value] of [["Severity", "warning"], ["Subsystem", "discord"], ["Provider", "claude"], ["Project", project.id], ["Time", "3600000"]]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "delivery" } }); await settle();
    expect(h.queryDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({
      offset: 0, search: "delivery", severity: "warning", subsystem: "discord", providerId: "claude", projectId: project.id,
      after: expectedCutoff,
    }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unmatched" } }); await settle();
    expect(screen.getByText("No incidents match these filters")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export filtered" })).toBeDisabled();
  });

  it("links original context, handles deleted labels, and keeps historical observations distinct from recovery", async () => {
    const incident = { ...record(1, "turn.inactivity"), outcome: "observing" as const };
    const h = setup([incident], { runtime: "ready" }); await settle();
    h.rerender(<DiagnosticsSettings {...h.props} conversations={[]} projects={[]} selection={{ incidentId: incident.id }} />); await settle();
    expect(screen.getByText("Historical observation")).toBeVisible();
    expect(screen.getByText("Unavailable or deleted conversation")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open affected conversation" })).toBeDisabled();
    expect(screen.getByLabelText("Severity")).toHaveValue("all");
    fireEvent.click(screen.getByRole("button", { name: "Show all incidents" })); await settle();
    expect(h.queryDiagnostics.mock.calls.at(-1)![0]).not.toHaveProperty("incidentId");
  });

  it("uses allowlisted navigation, coalesces notifications and exposes disk failure without losing copy access", async () => {
    const h = setup([record(1)], { persistence: "unavailable", dropped: 2 }); await settle();
    expect(screen.getByText(/New incidents are kept in bounded memory/u)).toBeVisible();
    fireEvent.click(screen.getByText("Discord delivery could not be confirmed"));
    const navigation = vi.fn(); window.addEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigation);
    fireEvent.click(screen.getByRole("button", { name: "Open Discord settings" }));
    expect((navigation.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "discord" });
    window.removeEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigation);
    for (let n = 0; n < 50; n++) h.publish();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(h.queryDiagnostics).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Copy incident" })).toBeEnabled();
  });
});
