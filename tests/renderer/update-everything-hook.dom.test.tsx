import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSnapshot,
  ConversationShell,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
  ServerEvent,
} from "../../src/shared/contracts";
import type { AppUpdateStatus } from "../../src/shared/desktop";
import type { AgentRunState } from "../../src/shared/run-state";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { useUpdateEverything } from "../../src/renderer/src/hooks/useUpdateEverything";
import { updateEverythingPlan, updateEverythingProgress } from "../../src/renderer/src/components/sidebar/updateEverythingPlan";
import { updateStatus } from "../support/app-update-fixture";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

function maintenance(providerId: ProviderMaintenanceProviderId, overrides: Partial<ProviderMaintenanceStatus> = {}): ProviderMaintenanceStatus {
  return {
    providerId, installedVersion: "1.0.0", latestVersion: "1.1.0", versionStatus: "update-available", freshness: "fresh",
    checkedAt: "2030-01-01T00:00:00.000Z", installMethod: "npm-global", updateAvailability: "available", updateLabel: "npm",
    instructionsUrl: "https://example.invalid", message: null, manualCommand: null, ...overrides,
  };
}

function statusMap(...statuses: ProviderMaintenanceStatus[]): Map<ProviderMaintenanceProviderId, ProviderMaintenanceStatus> {
  return new Map(statuses.map((status) => [status.providerId, status]));
}

function operation(providerId: ProviderMaintenanceProviderId, status: ProviderMaintenanceOperation["status"]): ProviderMaintenanceOperation {
  return {
    id: crypto.randomUUID(), providerId, status, startedAt: null, finishedAt: null, beforeVersion: "1.0.0",
    afterVersion: null, targetVersion: "1.1.0", message: "", output: null, outputTruncated: false,
  };
}

function chat(id: string, providerId: ProviderMaintenanceProviderId, state: AgentRunState | null, extra: Partial<ConversationShell> = {}): ConversationShell {
  return {
    id, providerId, pendingApproval: false, pendingInput: false,
    latestTurn: state ? { id: `${id}-turn`, providerId, status: "running", runState: { state, providerState: null, revision: 1 } } : null,
    ...extra,
  } as unknown as ConversationShell;
}

function snapshot(conversations: ConversationShell[] = []): AppSnapshot {
  return {
    conversations,
    providers: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }, { id: "cursor", label: "Cursor" }],
    settings: { providerIdentityLabels: { claude: "Claude Code" } },
  } as unknown as AppSnapshot;
}

const NO_OPERATIONS = new Map<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>();

function runResult(readyForAppInstall: boolean): ServerEvent {
  return {
    type: "request.result", requestId: "request",
    result: { kind: "updates.run", providers: [], interruptedConversationIds: [], readyForAppInstall },
  };
}

const ok: ServerEvent = { type: "request.ok", requestId: "request" };
const download = vi.fn<() => Promise<AppUpdateStatus>>();
const install = vi.fn<() => Promise<AppUpdateStatus>>();
let statusListener: ((status: AppUpdateStatus) => void) | null = null;

beforeEach(() => {
  statusListener = null;
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    downloadAppUpdate: download, installAppUpdate: install,
    onAppUpdateStatus: (listener: (status: AppUpdateStatus) => void) => { statusListener = listener; return () => { statusListener = null; }; },
  } });
});
afterEach(() => {
  vi.resetAllMocks();
  Reflect.deleteProperty(window, "inertia");
});

describe("update everything plan", () => {
  it("stays off without a versioned provider update", () => {
    expect(updateEverythingPlan({ snapshot: snapshot(), statuses: statusMap(), operations: NO_OPERATIONS, appStatus: updateStatus() })).toBeNull();
    expect(updateEverythingPlan({
      snapshot: snapshot(),
      statuses: statusMap(
        maintenance("codex", { versionStatus: "current", latestVersion: "1.0.0" }),
        maintenance("claude", { updateAvailability: "instructions-only" }),
        maintenance("cursor", { installMethod: "provider-managed", versionStatus: "unknown", latestVersion: null }),
      ),
      operations: NO_OPERATIONS,
      appStatus: null,
    })).toBeNull();
  });

  it("lists updatable providers in catalogue order with their display names and joins provider-managed ones", () => {
    const plan = updateEverythingPlan({
      snapshot: snapshot(),
      statuses: statusMap(
        maintenance("cursor", { installMethod: "provider-managed", versionStatus: "unknown", latestVersion: null, installedVersion: "2025.1" }),
        maintenance("claude", { installedVersion: "2.1.283", latestVersion: "2.1.295" }),
        maintenance("codex", { installedVersion: "0.112.0", latestVersion: "0.113.0" }),
        maintenance("kimi"),
      ),
      operations: new Map([["kimi", operation("kimi", "running")]]),
      appStatus: null,
    });
    expect(plan?.app).toBeNull();
    expect(plan?.providers).toEqual([
      { providerId: "codex", label: "Codex", from: "0.112.0", to: "0.113.0" },
      { providerId: "claude", label: "Claude Code", from: "2.1.283", to: "2.1.295" },
      { providerId: "cursor", label: "Cursor", from: "2025.1", to: null },
    ]);
  });

  it("includes an in-app update, points manual builds at the release page, and steps aside for app-only states", () => {
    const base = { snapshot: snapshot(), statuses: statusMap(maintenance("codex")), operations: NO_OPERATIONS };
    expect(updateEverythingPlan({ ...base, appStatus: updateStatus({ currentVersion: "0.0.71", latestVersion: "0.0.72" }) }))
      .toMatchObject({ app: { from: "0.0.71", to: "0.0.72" }, releasePageVersion: null });
    expect(updateEverythingPlan({ ...base, appStatus: updateStatus({ state: "downloaded" }) })?.app).not.toBeNull();
    expect(updateEverythingPlan({ ...base, appStatus: updateStatus({ delivery: "manual", latestVersion: "0.0.72" }) }))
      .toMatchObject({ app: null, releasePageVersion: "0.0.72" });
    expect(updateEverythingPlan({ ...base, appStatus: updateStatus({ state: "current" }) })?.app).toBeNull();
    for (const appStatus of [
      updateStatus({ state: "downloading" }),
      updateStatus({ state: "installing" }),
      updateStatus({ state: "downloaded", installBlocker: "active-work" }),
    ]) expect(updateEverythingPlan({ ...base, appStatus })).toBeNull();
  });

  it("counts every running chat when the app restarts and only updated providers' chats otherwise", () => {
    const conversations = [
      chat("a", "codex", "running"),
      chat("b", "claude", "starting"),
      chat("c", "codex", "waiting-for-approval"),
      chat("d", "codex", "running", { pendingInput: true }),
      chat("e", "cursor", "completed"),
      chat("f", "kimi", null),
      chat("g", "codex", "delegated"),
      chat("h", "codex", "retrying"),
      chat("i", "codex", "queued"),
    ];
    const statuses = statusMap(maintenance("codex"));
    expect(updateEverythingPlan({ snapshot: snapshot(conversations), statuses, operations: NO_OPERATIONS, appStatus: updateStatus() }))
      .toMatchObject({ runningChats: 7, continuingChats: 4 });
    expect(updateEverythingPlan({ snapshot: snapshot(conversations), statuses, operations: NO_OPERATIONS, appStatus: null }))
      .toMatchObject({ runningChats: 6, continuingChats: 3 });
  });

  it("names the provider being updated, then the app", () => {
    const phase = { kind: "providers", providerIds: ["codex", "claude"] } as const;
    expect(updateEverythingProgress(phase, NO_OPERATIONS, snapshot())).toBe("Updating Codex…");
    expect(updateEverythingProgress(phase, new Map([["claude", operation("claude", "queued")]]), snapshot())).toBe("Updating Claude Code…");
    expect(updateEverythingProgress(phase, new Map([
      ["codex", operation("codex", "queued")], ["claude", operation("claude", "running")],
    ]), snapshot())).toBe("Updating Claude Code…");
    expect(updateEverythingProgress({ kind: "app" }, NO_OPERATIONS, snapshot())).toBe("Updating Inertia…");
  });
});

function harness(appStatus: AppUpdateStatus | null, request: (command: CommandWithoutId) => Promise<ServerEvent>) {
  return renderHook(({ status }) => useUpdateEverything({
    statuses: statusMap(maintenance("codex"), maintenance("claude")), operations: NO_OPERATIONS, appStatus: status, request,
  }), { initialProps: { status: appStatus } });
}

const providersOnly = { providerIds: ["codex", "claude"] as ProviderMaintenanceProviderId[], includeApp: false, continueChats: true };
const withApp = { ...providersOnly, includeApp: true };

describe("update everything run", () => {
  it("updates providers, then releases the runtime hold when there is no app step", async () => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(false) : ok);
    const hook = harness(null, request);
    await act(async () => hook.result.current.run(providersOnly));
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: "updates.run", payload: providersOnly },
      { type: "updates.finish", payload: { installed: false } },
    ]);
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBeNull();
  });

  it("downloads an available update, then installs it without releasing the hold", async () => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    download.mockResolvedValue(updateStatus({ state: "downloaded" }));
    install.mockResolvedValue(updateStatus({ state: "installing" }));
    const hook = harness(updateStatus(), request);
    await act(async () => hook.result.current.run(withApp));
    expect(download).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(["updates.run"]);
  });

  it("finishes the download before the run starts, so the hold never covers it", async () => {
    const order: string[] = [];
    const request = vi.fn(async (command: CommandWithoutId) => {
      order.push(command.type);
      return command.type === "updates.run" ? runResult(true) : ok;
    });
    download.mockImplementation(async () => { order.push("download"); return updateStatus({ state: "downloading" }); });
    install.mockImplementation(async () => { order.push("install"); return updateStatus({ state: "installing" }); });
    const hook = harness(updateStatus(), request);
    let finished = false;
    let running!: Promise<void>;
    act(() => { running = hook.result.current.run(withApp).then(() => { finished = true; }); });
    await vi.waitFor(() => expect(statusListener).not.toBeNull());
    expect(request).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toEqual({ kind: "download" });
    expect(updateEverythingProgress({ kind: "download" }, NO_OPERATIONS, snapshot())).toBe("Downloading Inertia…");
    await act(async () => { statusListener?.(updateStatus({ state: "downloaded" })); await running; });
    expect(finished).toBe(true);
    expect(order).toEqual(["download", "updates.run", "install"]);
  });

  it.each([
    ["fails", updateStatus({ state: "failed", message: "The update could not be downloaded. Try again when your connection is stable." })],
    ["is cancelled", updateStatus({ state: "cancelled", message: "The update download was cancelled." })],
  ])("starts no run when the download %s", async (_name, settled) => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    download.mockResolvedValue(settled);
    const hook = harness(updateStatus(), request);
    await act(async () => hook.result.current.run(withApp));
    expect(request).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });

  it("starts no run when the download cannot be started", async () => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    download.mockRejectedValue(new Error("Error invoking remote method: /private/path"));
    const hook = harness(updateStatus(), request);
    await act(async () => hook.result.current.run(withApp));
    expect(request).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("The update download could not be started.");
  });

  it("installs an already downloaded update directly", async () => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    install.mockResolvedValue(updateStatus({ state: "installing" }));
    const hook = harness(updateStatus({ state: "downloaded" }), request);
    await act(async () => hook.result.current.run(withApp));
    expect(download).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    ["a restart blocker", () => install.mockResolvedValue(updateStatus({ state: "downloaded", installBlocker: "terminal" }))],
    ["a failed install", () => install.mockResolvedValue(updateStatus({ state: "failed", installBlocker: "shutdown" }))],
    ["a rejected install", () => install.mockRejectedValue(new Error("Error invoking remote method: /private/path"))],
  ])("releases the hold after %s", async (_name, arrange) => {
    arrange();
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    const hook = harness(updateStatus({ state: "downloaded" }), request);
    await act(async () => hook.result.current.run(withApp));
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "updates.finish", payload: { installed: false } });
    expect(hook.result.current.phase).toBeNull();
    expect(hook.result.current.error ?? "").not.toContain("/private/path");
  });

  it("reports a rejected install with the app updater's own wording", async () => {
    install.mockRejectedValue(new Error("Error invoking remote method: /private/path"));
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(true) : ok);
    const hook = harness(updateStatus({ state: "downloaded" }), request);
    await act(async () => hook.result.current.run(withApp));
    expect(hook.result.current.error).toBe("The update restart could not be started safely.");
  });

  it("skips the app when the runtime is not ready for it", async () => {
    const request = vi.fn(async (command: CommandWithoutId) => command.type === "updates.run" ? runResult(false) : ok);
    const hook = harness(updateStatus({ state: "downloaded" }), request);
    await act(async () => hook.result.current.run(withApp));
    expect(install).not.toHaveBeenCalled();
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "updates.finish", payload: { installed: false } });
  });

  it("surfaces a refused run without releasing another run's hold", async () => {
    const request = vi.fn(async () => { throw new Error("Inertia is updating."); });
    const hook = harness(null, request);
    await act(async () => hook.result.current.run(providersOnly));
    expect(request).toHaveBeenCalledOnce();
    expect(hook.result.current.error).toBe("Inertia is updating.");
    act(() => hook.result.current.dismissError());
    expect(hook.result.current.error).toBeNull();
  });

  it("never starts two runs at once and reports the running phase", async () => {
    const response = deferred<ServerEvent>();
    const request = vi.fn((command: CommandWithoutId) => command.type === "updates.run" ? response.promise : Promise.resolve(ok));
    const hook = harness(null, request);
    let first!: Promise<void>;
    act(() => { first = hook.result.current.run(providersOnly); });
    await act(async () => hook.result.current.run(providersOnly));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(hook.result.current.phase).toEqual({ kind: "providers", providerIds: ["codex", "claude"] });
    await act(async () => { response.resolve(runResult(false)); await first; });
    expect(hook.result.current.phase).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
