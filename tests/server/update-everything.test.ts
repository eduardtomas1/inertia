import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicRuntimeError } from "../../src/server/runtime-errors";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createUpdatesCommandHandler } from "../../src/server/runtime/commands/updates-commands";
import {
  runUpdateEverything,
  type UpdateEverythingDependencies,
  type UpdatesRunRequest,
} from "../../src/server/runtime/update-everything";
import {
  isHeld,
  release,
  UPDATE_HOLD_SAFETY_RELEASE_MS,
} from "../../src/server/runtime/update-hold";
import {
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import {
  ProviderMaintenanceController,
  ProviderMaintenanceError,
} from "../../src/server/provider/maintenance-controller";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../src/shared/provider-maintenance";
import { providerMaintenanceJournalTestDouble } from "../support/provider-maintenance-journal";

afterEach(() => {
  release();
  vi.useRealTimers();
});

function socket(): WebSocket {
  return Object.assign(new EventEmitter(), { readyState: 1 }) as unknown as WebSocket;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

const CODEX_CHAT = "11111111-1111-4111-8111-111111111111";
const CLAUDE_CHAT = "22222222-2222-4222-8222-222222222222";
const CURSOR_CHAT = "33333333-3333-4333-8333-333333333333";

type Terminal = Pick<ProviderMaintenanceOperation, "status" | "message"> & {
  afterVersion?: string | null;
};

function operation(
  providerId: ProviderMaintenanceProviderId,
  update: Partial<ProviderMaintenanceOperation> = {},
): ProviderMaintenanceOperation {
  return {
    id: randomUUID(),
    providerId,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    beforeVersion: "1.0.0",
    afterVersion: null,
    targetVersion: "2.0.0",
    message: "Waiting to start the provider update.",
    output: null,
    outputTruncated: false,
    ...update,
  };
}

function fixture(options: {
  running?: string[];
  providers?: Record<string, ProviderMaintenanceProviderId>;
  outcomes?: Partial<Record<ProviderMaintenanceProviderId, Terminal | Error>>;
  plans?: (conversationIds: readonly string[]) => string[];
} = {}) {
  const order: string[] = [];
  const providerOf = options.providers ?? {
    [CODEX_CHAT]: "codex",
    [CLAUDE_CHAT]: "claude",
    [CURSOR_CHAT]: "cursor",
  };
  const operations = new Map<string, ProviderMaintenanceOperation>();
  const settling = new Map<string, () => void>();
  const maintenance = {
    current: vi.fn((providerId: ProviderMaintenanceProviderId) => [{ installedVersion: `${providerId}-installed` }]),
    startUpdate: vi.fn(async (providerId: ProviderMaintenanceProviderId) => {
      order.push(`start:${providerId}:held=${isHeld()}`);
      const outcome = options.outcomes?.[providerId] ?? { status: "succeeded", message: "Provider updated.", afterVersion: "2.0.0" };
      if (outcome instanceof Error) throw outcome;
      const started = operation(providerId);
      operations.set(started.id, started);
      settling.set(started.id, () => {
        operations.set(started.id, { ...started, afterVersion: null, ...outcome, finishedAt: new Date().toISOString() });
      });
      return started;
    }),
    settled: vi.fn(async (operationId: string) => {
      await Promise.resolve();
      settling.get(operationId)?.();
      order.push(`settled:${operations.get(operationId)?.providerId}`);
      return operations.get(operationId) ?? null;
    }),
  };
  const turns = {
    activeConversationIds: vi.fn(() => options.running ?? [CODEX_CHAT, CLAUDE_CHAT, CURSOR_CHAT]),
    interruptForUpdate: vi.fn(async (conversationIds: readonly string[]) => {
      order.push(`interrupt:${conversationIds.join(",")}:held=${isHeld()}`);
      return true;
    }),
  };
  const restartContinuation = {
    createPlans: vi.fn((conversationIds: readonly string[]) => {
      order.push(`plans:${conversationIds.join(",")}:held=${isHeld()}`);
      return options.plans ? options.plans(conversationIds) : [...conversationIds];
    }),
    arm: vi.fn(() => { order.push(`arm:held=${isHeld()}`); }),
  };
  const store = {
    conversation: vi.fn((conversationId: string) => {
      const providerId = providerOf[conversationId];
      if (!providerId) throw new Error("missing");
      return { providerId };
    }),
  };
  const preparation = {
    isAdmissionClosed: vi.fn(() => false),
    restartBlockerBesidesAgentTurns: vi.fn((): "database-recovery" | "agent-work" | "terminal" | null => null),
    providerActivityBlocker: vi.fn((): "provider-maintenance" | "provider-refresh" | null => {
      order.push("provider-activity");
      return null;
    }),
  };
  const dependencies = {
    store,
    turns,
    maintenance,
    restartContinuation,
    preparation,
  } as unknown as UpdateEverythingDependencies;
  const run = (request: Partial<UpdatesRunRequest> = {}, owner: WebSocket = socket()) => runUpdateEverything(dependencies, {
    providerIds: ["codex", "claude"],
    includeApp: false,
    continueChats: true,
    ...request,
  }, owner);
  return { order, maintenance, turns, restartContinuation, preparation, dependencies, run };
}

describe("update everything orchestration", () => {
  it("plans, interrupts, then updates providers one at a time under the hold and releases it", async () => {
    const subject = fixture({ plans: (ids) => ids.filter((id) => id === CODEX_CHAT) });

    const result = await subject.run();

    expect(subject.order).toEqual([
      `plans:${CODEX_CHAT},${CLAUDE_CHAT}:held=true`,
      `interrupt:${CODEX_CHAT},${CLAUDE_CHAT}:held=true`,
      "start:codex:held=true",
      "settled:codex",
      "start:claude:held=true",
      "settled:claude",
      "arm:held=false",
    ]);
    expect(result).toEqual({
      kind: "updates.run",
      providers: [
        { providerId: "codex", outcome: "updated", beforeVersion: "1.0.0", afterVersion: "2.0.0", error: null },
        { providerId: "claude", outcome: "updated", beforeVersion: "1.0.0", afterVersion: "2.0.0", error: null },
      ],
      interruptedConversationIds: [CODEX_CHAT, CLAUDE_CHAT],
      readyForAppInstall: false,
      appInstallBlocker: null,
    });
    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("interrupts every running chat when Inertia itself restarts", async () => {
    const subject = fixture({ running: [CODEX_CHAT, CURSOR_CHAT, "deleted-chat"] });

    const result = await subject.run({ providerIds: ["codex"], includeApp: true });

    expect(result.interruptedConversationIds).toEqual([CODEX_CHAT, CURSOR_CHAT, "deleted-chat"]);
    expect(subject.restartContinuation.createPlans).toHaveBeenCalledWith([CODEX_CHAT, CURSOR_CHAT, "deleted-chat"]);
    expect(subject.turns.interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT, CURSOR_CHAT, "deleted-chat"], "Inertia");
  });

  it("names every provider being updated when Inertia does not restart", async () => {
    const subject = fixture();

    await subject.run({ providerIds: ["codex", "claude", "cursor"] });

    expect(subject.turns.interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT, CLAUDE_CHAT, CURSOR_CHAT], "Codex, Claude and Cursor");
  });

  it("leaves chats on other providers running and skips chats it cannot resolve", async () => {
    const subject = fixture({ running: [CODEX_CHAT, CURSOR_CHAT, "deleted-chat"] });

    const result = await subject.run({ providerIds: ["codex"] });

    expect(result.interruptedConversationIds).toEqual([CODEX_CHAT]);
    expect(subject.restartContinuation.createPlans).toHaveBeenCalledWith([CODEX_CHAT]);
    expect(subject.turns.interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT], "Codex");
  });

  it.each([
    ["terminal", "Close active terminals before restarting to update."],
    ["agent-work", "Wait for workspace runs to finish before restarting to update."],
    ["database-recovery", "Wait for database recovery to finish before restarting."],
  ] as const)("stops only the updated providers' chats when a %s would refuse the restart anyway", async (blocker, message) => {
    const subject = fixture();
    subject.preparation.restartBlockerBesidesAgentTurns.mockReturnValue(blocker);

    const result = await subject.run({ providerIds: ["codex"], includeApp: true });

    expect(subject.restartContinuation.createPlans).toHaveBeenCalledWith([CODEX_CHAT]);
    expect(subject.turns.interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT], "Codex");
    expect(result).toMatchObject({ interruptedConversationIds: [CODEX_CHAT], readyForAppInstall: false, appInstallBlocker: message });
    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider-maintenance", "Wait for provider maintenance to finish before restarting."],
    ["provider-refresh", "Wait for provider checks to finish before restarting."],
  ] as const)("keeps the app out of the run when %s is still active after the provider updates", async (blocker, message) => {
    const subject = fixture();
    subject.preparation.providerActivityBlocker.mockImplementation(() => {
      subject.order.push("provider-activity");
      return blocker;
    });

    const result = await subject.run({ providerIds: ["codex"], includeApp: true });

    expect(subject.order.slice(-3)).toEqual(["settled:codex", "provider-activity", "arm:held=false"]);
    expect(result).toMatchObject({ readyForAppInstall: false, appInstallBlocker: message });
    expect(result.providers.map(({ outcome }) => outcome)).toEqual(["updated"]);
    expect(isHeld()).toBe(false);
  });

  it("reports no app blocker when the restart can proceed or the app is not part of the run", async () => {
    const subject = fixture();
    await expect(subject.run({ includeApp: true })).resolves.toMatchObject({ readyForAppInstall: true, appInstallBlocker: null });
    release();
    subject.preparation.restartBlockerBesidesAgentTurns.mockReturnValue("terminal");
    await expect(subject.run()).resolves.toMatchObject({ readyForAppInstall: false, appInstallBlocker: null });
    expect(subject.turns.interruptForUpdate).toHaveBeenLastCalledWith([CODEX_CHAT, CLAUDE_CHAT], "Codex and Claude");
  });

  it("keeps the app out of the run when interrupted chats do not stop in time, and still updates providers", async () => {
    const subject = fixture();
    subject.turns.interruptForUpdate.mockResolvedValue(false);

    const app = await subject.run({ includeApp: true });

    expect(app).toMatchObject({ readyForAppInstall: false, appInstallBlocker: "Active agent work did not stop in time." });
    expect(app.providers.map(({ outcome }) => outcome)).toEqual(["updated", "updated"]);
    expect(isHeld()).toBe(false);
    await expect(subject.run()).resolves.toMatchObject({ readyForAppInstall: false, appInstallBlocker: null });
  });

  it("does not plan continuations when the user turned them off", async () => {
    const subject = fixture();

    await subject.run({ continueChats: false });

    expect(subject.restartContinuation.createPlans).not.toHaveBeenCalled();
    expect(subject.turns.interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT, CLAUDE_CHAT], "Codex and Claude");
  });

  it("keeps updating the rest when one provider fails, stays unchanged or is cancelled", async () => {
    const subject = fixture({
      outcomes: {
        codex: new ProviderMaintenanceError("This installation cannot be updated safely from Inertia. Review the official update instructions."),
        claude: { status: "failed", message: "Provider update command failed." },
        kimi: { status: "unchanged", message: "Update completed, but the installed version still appears unchanged.", afterVersion: "1.0.0" },
        opencode: { status: "cancelled", message: "Provider update cancelled." },
      },
    });

    const result = await subject.run({ providerIds: ["codex", "claude", "kimi", "opencode", "cursor"] });

    expect(result.providers).toEqual([
      { providerId: "codex", outcome: "failed", beforeVersion: "codex-installed", afterVersion: null, error: "This installation cannot be updated safely from Inertia. Review the official update instructions." },
      { providerId: "claude", outcome: "failed", beforeVersion: "1.0.0", afterVersion: null, error: "Provider update command failed." },
      { providerId: "kimi", outcome: "unchanged", beforeVersion: "1.0.0", afterVersion: "1.0.0", error: null },
      { providerId: "opencode", outcome: "skipped", beforeVersion: "1.0.0", afterVersion: null, error: "Provider update cancelled." },
      { providerId: "cursor", outcome: "updated", beforeVersion: "1.0.0", afterVersion: "2.0.0", error: null },
    ]);
    expect(subject.maintenance.startUpdate).toHaveBeenCalledTimes(5);
    expect(isHeld()).toBe(false);
  });

  it("keeps an unchanged update's message only when the update reports a problem", async () => {
    const quarantined = "Update completed, but Inertia could not verify the installed version. The installation remains quarantined.";
    const subject = fixture({
      outcomes: {
        codex: { status: "unchanged", message: "Update completed, but the installed version still appears unchanged.", afterVersion: "1.0.0" },
        claude: { status: "unchanged", message: quarantined },
      },
    });

    const result = await subject.run();

    expect(result.providers.map(({ outcome, error }) => ({ outcome, error }))).toEqual([
      { outcome: "unchanged", error: null },
      { outcome: "unchanged", error: quarantined },
    ]);
  });

  it("keeps the hold for the app install and releases it only when the renderer finishes without installing", async () => {
    const subject = fixture();

    const result = await subject.run({ includeApp: true });

    expect(result.readyForAppInstall).toBe(true);
    expect(isHeld()).toBe(true);
    expect(subject.restartContinuation.arm).not.toHaveBeenCalled();
  });

  it("releases a forgotten app-install hold after ten minutes and arms the continuations", async () => {
    vi.useFakeTimers();
    const subject = fixture();

    await subject.run({ includeApp: true });
    vi.advanceTimersByTime(UPDATE_HOLD_SAFETY_RELEASE_MS - 1);
    expect(isHeld()).toBe(true);
    vi.advanceTimersByTime(1);

    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("refuses a second run while one is in progress without interrupting anything", async () => {
    const subject = fixture();
    const interrupted = deferred<boolean>();
    subject.turns.interruptForUpdate.mockReturnValueOnce(interrupted.promise);
    const first = subject.run({ includeApp: true });

    await expect(subject.run()).rejects.toThrow("Inertia is updating.");

    expect(subject.turns.interruptForUpdate).toHaveBeenCalledOnce();
    interrupted.resolve(true);
    await first;
    expect(isHeld()).toBe(true);
  });

  it("lets a fresh run take over the hold once the previous run has returned", async () => {
    const subject = fixture();
    const firstOwner = socket();
    await subject.run({ includeApp: true }, firstOwner);

    const second = subject.run({ includeApp: true });
    expect(isHeld()).toBe(true);
    await expect(second).resolves.toMatchObject({ readyForAppInstall: true });
    firstOwner.emit("close");

    expect(subject.turns.interruptForUpdate).toHaveBeenCalledTimes(2);
    expect(isHeld()).toBe(true);
    expect(subject.restartContinuation.arm).not.toHaveBeenCalled();
  });

  it("releases the hold and arms continuations when the renderer that started the run goes away", async () => {
    const subject = fixture();
    const owner = socket();
    await subject.run({ includeApp: true }, owner);
    expect(isHeld()).toBe(true);

    owner.emit("close");

    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("releases the hold as soon as the run returns when its renderer went away during the run", async () => {
    const subject = fixture();
    const owner = socket();
    const interrupted = deferred<boolean>();
    subject.turns.interruptForUpdate.mockReturnValueOnce(interrupted.promise);
    const running = subject.run({ includeApp: true }, owner);

    owner.emit("close");
    expect(isHeld()).toBe(true);
    interrupted.resolve(true);

    await expect(running).resolves.toMatchObject({ readyForAppInstall: true });
    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("keeps the hold when the renderer goes away after the app install took over", async () => {
    const subject = fixture();
    const owner = socket();
    await subject.run({ includeApp: true }, owner);
    subject.preparation.isAdmissionClosed.mockReturnValue(true);

    owner.emit("close");

    expect(isHeld()).toBe(true);
    expect(subject.restartContinuation.arm).not.toHaveBeenCalled();
  });

  it("releases the hold and reports the failure when chats cannot be interrupted", async () => {
    const subject = fixture();
    subject.turns.interruptForUpdate.mockRejectedValueOnce(new Error("interrupt failed"));

    await expect(subject.run({ includeApp: true })).rejects.toThrow("interrupt failed");

    expect(subject.maintenance.startUpdate).not.toHaveBeenCalled();
    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });
});

describe("update everything with the real maintenance controller", () => {
  function controllerFixture() {
    const leases = new ProviderInstallationLeaseCoordinator();
    let version = "1.0.0";
    const target = () => ({ providerId: "codex" as const, executable: "/tools/codex", installedVersion: version, installed: true });
    const blockers = vi.fn();
    const controller = new ProviderMaintenanceController({
      maintenanceJournal: providerMaintenanceJournalTestDouble(),
      installationLeases: leases,
      maintenanceAdmissionTimeoutMs: 200,
      target,
      refreshTarget: async () => target(),
      resolveCapabilities: async () => ({
        providerId: "codex",
        packageName: null,
        installMethod: "provider-managed",
        updateAvailability: "available",
        update: {
          executable: "/tools/codex",
          args: ["update"],
          lockKey: "native:codex",
          installMethod: "provider-managed",
          label: "Update Codex",
        },
        instructionsUrl: "https://example.test/update",
      }),
      runAction: async () => {
        version = "2.0.0";
        return {
          status: "succeeded",
          exitCode: 0,
          signal: null,
          message: "Provider update command completed.",
          cleanupConfirmed: true,
          output: null,
          outputTruncated: false,
        };
      },
      onBlockers: blockers,
    });
    const runningChat = leases.acquireUse(providerInstallationIdentity({
      providerId: "codex",
      executable: "/tools/codex",
      installationRootIdentity: null,
      packageIdentity: null,
      version: "1.0.0",
      environmentIdentity: "runtime-provider-environment",
    }), { kind: "provider-run", operationId: "running-codex-turn" });
    return { controller, blockers, runningChat };
  }

  it("updates without waiting on installation owners because the interrupted turns released them", async () => {
    const { controller, blockers, runningChat } = controllerFixture();
    const interruptForUpdate = vi.fn(async () => runningChat.release({ cleanupConfirmed: true }));

    const result = await runUpdateEverything({
      store: { conversation: () => ({ providerId: "codex" }) },
      turns: { activeConversationIds: () => [CODEX_CHAT], interruptForUpdate },
      maintenance: controller,
      restartContinuation: { createPlans: (ids: readonly string[]) => [...ids], arm: () => undefined },
      preparation: { isAdmissionClosed: () => false, restartBlockerBesidesAgentTurns: () => null, providerActivityBlocker: () => null },
    } as unknown as UpdateEverythingDependencies, { providerIds: ["codex"], includeApp: false, continueChats: true }, socket());

    expect(result.providers).toEqual([
      { providerId: "codex", outcome: "updated", beforeVersion: "1.0.0", afterVersion: "2.0.0", error: null },
    ]);
    expect(interruptForUpdate).toHaveBeenCalledWith([CODEX_CHAT], "Codex");
    await expect(interruptForUpdate.mock.results[0]!.value).resolves.toBe(true);
    expect(blockers).not.toHaveBeenCalled();
    expect(controller.hasBlockingAuthority("codex")).toBe(false);
  });

  it("would have waited on and failed against a chat that kept running", async () => {
    const { controller, blockers, runningChat } = controllerFixture();

    const result = await runUpdateEverything({
      store: { conversation: () => ({ providerId: "claude" }) },
      turns: { activeConversationIds: () => [CLAUDE_CHAT], interruptForUpdate: async () => true },
      maintenance: controller,
      restartContinuation: { createPlans: (ids: readonly string[]) => [...ids], arm: () => undefined },
      preparation: { isAdmissionClosed: () => false, restartBlockerBesidesAgentTurns: () => null, providerActivityBlocker: () => null },
    } as unknown as UpdateEverythingDependencies, { providerIds: ["codex"], includeApp: false, continueChats: true }, socket());

    expect(result.interruptedConversationIds).toEqual([]);
    expect(result.providers[0]).toMatchObject({ providerId: "codex", outcome: "failed" });
    expect(blockers).toHaveBeenCalled();
    runningChat.release({ cleanupConfirmed: true });
  });
});

describe("updates command handler", () => {
  function handlerFixture() {
    const subject = fixture();
    const events: ServerEvent[] = [];
    const send = vi.fn((_socket: WebSocket, event: ServerEvent) => { events.push(event); });
    const owner = socket();
    const handler = createUpdatesCommandHandler({ ...subject.dependencies, send });
    const execute = createRuntimeCommandExecutor({
      handlers: [
        handler,
        defineRuntimeCommandHandler(
          RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
          async () => "not-handled",
        ),
      ],
      send,
      broadcastSnapshot: vi.fn(),
      publicError: publicRuntimeError,
    });
    const run = async (type: ClientCommand["type"], payload: unknown) => {
      const command = clientCommandSchema.parse({ type, requestId: randomUUID(), payload });
      events.length = 0;
      await execute(owner, command);
      return { command, events: [...events] };
    };
    return { ...subject, handler, run, owner };
  }

  it("owns exactly the update commands", () => {
    expect([...(handlerFixture().handler.commandTypes ?? [])].sort()).toEqual(["updates.finish", "updates.run"]);
  });

  it("answers a run with a result the renderer accepts", async () => {
    const subject = handlerFixture();

    const { command, events } = await subject.run("updates.run", {
      providerIds: ["codex"],
      includeApp: true,
      continueChats: true,
    });

    expect(events).toHaveLength(1);
    expect(serverEventSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]).toEqual({
      type: "request.result",
      requestId: command.requestId,
      result: {
        kind: "updates.run",
        providers: [{ providerId: "codex", outcome: "updated", beforeVersion: "1.0.0", afterVersion: "2.0.0", error: null }],
        interruptedConversationIds: [CODEX_CHAT, CLAUDE_CHAT, CURSOR_CHAT],
        readyForAppInstall: true,
        appInstallBlocker: null,
      },
    });
    expect(isHeld()).toBe(true);
  });

  it("finishes without an install by releasing the hold once", async () => {
    const subject = handlerFixture();
    await subject.run("updates.run", { providerIds: [], includeApp: true, continueChats: true });
    expect(isHeld()).toBe(true);

    const finished = await subject.run("updates.finish", { installed: false });
    expect(finished.events).toEqual([{ type: "request.ok", requestId: finished.command.requestId }]);
    expect(isHeld()).toBe(false);
    await subject.run("updates.finish", { installed: false });
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("ties the hold to the socket that started the run", async () => {
    const subject = handlerFixture();
    await subject.run("updates.run", { providerIds: ["codex"], includeApp: true, continueChats: true });
    expect(isHeld()).toBe(true);

    subject.owner.emit("close");

    expect(isHeld()).toBe(false);
    expect(subject.restartContinuation.arm).toHaveBeenCalledOnce();
  });

  it("reports a run refused during another run as a request error", async () => {
    const subject = handlerFixture();
    const interrupted = deferred<boolean>();
    subject.turns.interruptForUpdate.mockReturnValueOnce(interrupted.promise);
    const first = subject.run("updates.run", { providerIds: ["codex"], includeApp: true, continueChats: true });

    const { command, events } = await subject.run("updates.run", { providerIds: ["codex"], includeApp: false, continueChats: true });

    expect(events).toEqual([{ type: "request.error", requestId: command.requestId, message: "Inertia is updating." }]);
    interrupted.resolve(true);
    await first;
  });

  it("accepts only distinct maintenance providers and some work to do", () => {
    const parse = (payload: unknown) => clientCommandSchema.safeParse({
      type: "updates.run",
      requestId: randomUUID(),
      payload,
    }).success;
    expect(parse({ providerIds: ["codex", "antigravity"], includeApp: false, continueChats: false })).toBe(true);
    expect(parse({ providerIds: [], includeApp: true, continueChats: true })).toBe(true);
    expect(parse({ providerIds: [], includeApp: false, continueChats: true })).toBe(false);
    expect(parse({ providerIds: ["codex", "codex"], includeApp: false, continueChats: true })).toBe(false);
    expect(parse({ providerIds: ["custom"], includeApp: false, continueChats: true })).toBe(false);
    expect(parse({ providerIds: ["codex"], includeApp: false })).toBe(false);
    expect(clientCommandSchema.safeParse({
      type: "updates.finish",
      requestId: randomUUID(),
      payload: { installed: false, extra: true },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      type: "updates.finish",
      requestId: randomUUID(),
      payload: { installed: true },
    }).success).toBe(false);
  });
});
