// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { createInitiativeCommandHandler } from "../../src/server/runtime/commands/initiative-commands";
import {
  createInitiativeMcpResolver,
  initiativeMcpServerPlan,
  retryPendingInitiativeMcpForgets,
  type InitiativeMcpSecretBroker,
} from "../../src/server/runtime/initiative-mcp-runtime";
import {
  initiativeMcpPendingForgets,
  MAX_PENDING_INITIATIVE_MCP_FORGETS,
  readPendingInitiativeMcpForgets,
  writePendingInitiativeMcpForgets,
} from "../../src/server/runtime/initiative-mcp-pending-forgets";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import type { QueueTurnRequest, TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import {
  AgentHarnessRegistry,
  ProviderManager,
  type AgentHarness,
  type AgentHarnessStartOptions,
  type ProviderRunInput,
} from "../../src/server/providers";
import {
  providerRunTerminal,
  type ProviderInitiativeMcpPlan,
  type ProviderRunResult,
} from "../../src/server/provider/contracts";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { initiativeMcpSecretReference } from "../../src/node/initiative-mcp-secret-reference";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import {
  initiativeMcpSecretSlot,
  initiativeMcpServerDestination,
  type InitiativeMcpServer,
} from "../../src/shared/initiative-mcp";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { PROCESS_LIFECYCLE_CAPABILITIES_FOR_TESTS } from "../helpers/providers/process-lifecycle-harness";
import { nativeProviderRunFields, resolveNativeModelRoute } from "./model-route-fixture";

const SECRET = "fixture-initiative-mcp-secret-5d2e";
const ENV_SECRET = "fixture-initiative-env-secret-77c0";
const SERVER_A = "22222222-2222-4222-8222-222222222222";
const SERVER_B = "33333333-3333-4333-8333-333333333333";
const socket = {} as WebSocket;
const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tracker(overrides: Partial<InitiativeMcpServer> = {}): InitiativeMcpServer {
  return {
    id: SERVER_A,
    name: "tracker",
    enabled: true,
    transport: {
      kind: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", secret: true }, { name: "X-Team", value: "checkout" }],
    },
    ...overrides,
  };
}

function docs(overrides: Partial<InitiativeMcpServer> = {}): InitiativeMcpServer {
  return {
    id: SERVER_B,
    name: "docs",
    enabled: true,
    transport: { kind: "stdio", command: "npx", args: ["-y", "@example/docs-mcp"], env: [{ name: "DOCS_TOKEN", secret: true }] },
    ...overrides,
  };
}

/** An in-memory stand-in for the main-process vault behind the runtime broker. */
class FakeBroker implements InitiativeMcpSecretBroker {
  readonly values = new Map<string, string>();
  readonly forgotten: string[] = [];
  forgetAttempts = 0;
  /** Fails every forget, or only this many before succeeding. */
  failForget: boolean | number = false;
  failResolve = false;
  async resolve(reference: string): Promise<string | null> {
    if (this.failResolve) throw new Error("vault unavailable");
    return this.values.get(reference) ?? null;
  }
  async forget(reference: string): Promise<boolean> {
    this.forgetAttempts += 1;
    if (this.failForget === true) throw new Error("vault unavailable");
    if (typeof this.failForget === "number" && this.failForget > 0) {
      this.failForget -= 1;
      throw new Error("vault unavailable");
    }
    this.forgotten.push(reference);
    return this.values.delete(reference);
  }
}

/** The vault reference of one secret entry of a server, as main and the runtime derive it. */
function secretReference(initiativeId: string, server: InitiativeMcpServer, name: string): string {
  const kind = server.transport.kind === "http" ? "header" : "env";
  return initiativeMcpSecretReference(initiativeId, server.id, initiativeMcpSecretSlot(kind, name), initiativeMcpServerDestination(server));
}

function fixture(broker?: FakeBroker) {
  const root = mkdtempSync(join(tmpdir(), "inertia-initiative-mcp-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Checkout", root);
  const pending = initiativeMcpPendingForgets(root);
  const handler = createInitiativeCommandHandler({
    store,
    send: () => undefined,
    validateDefaultModel: (selection) => selection,
    ensureSkillsFolder: () => undefined,
    ...(broker ? { mcpSecrets: broker, mcpPendingForgets: pending } : {}),
  });
  const events: ServerEvent[] = [];
  const execute = createRuntimeCommandExecutor({
    handlers: [
      handler,
      defineRuntimeCommandHandler(
        RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
        async () => "not-handled",
      ),
    ],
    send: (_socket: WebSocket, event: ServerEvent) => { events.push(event); },
    broadcastSnapshot: () => undefined,
    publicError: publicRuntimeError,
  });
  const run = async (type: ClientCommand["type"], payload: unknown): Promise<ServerEvent> => {
    events.length = 0;
    await execute(socket, clientCommandSchema.parse({ type, requestId: randomUUID(), payload }));
    return events.at(-1)!;
  };
  const initiative = store.initiatives.create({ id: randomUUID(), name: "Checkout" });
  const reference = (server: InitiativeMcpServer, name: string) => secretReference(initiative.id, server, name);
  return { root, store, project, initiative, run, reference, pending };
}

describe("initiative MCP server settings", () => {
  it("stores servers without secret values and refuses malformed configuration at the boundary", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run, root } = fixture(broker);
    expect(await run("initiative.update", {
      id: initiative.id, expectedRevision: initiative.revision, preferences: { mcpServers: [tracker(), docs()] },
    })).toMatchObject({ type: "request.ok" });
    expect(store.initiatives.get(initiative.id)!.preferences.mcpServers).toEqual([tracker(), docs()]);
    for (const malformed of [
      [{ ...tracker(), transport: { kind: "http", url: "http://mcp.example.com/mcp", headers: [] } }],
      [{ ...tracker(), name: "inertia-chat-manager" }],
      [{ ...docs(), transport: { kind: "stdio", command: "npx -y server", args: [], env: [] } }],
      [{ ...docs(), transport: { kind: "stdio", command: "npx", args: ["a\nb"], env: [] } }],
      [{ ...tracker(), transport: { kind: "http", url: "https://x.example.com", headers: [{ name: "Authorization", value: "Bearer x", secret: true }] } }],
      [{ ...tracker(), transport: { kind: "http", url: "https://x.example.com", headers: [{ name: "Authorization", secretRef: "secret:backend:abc" }] } }],
    ]) {
      expect(clientCommandSchema.safeParse({
        type: "initiative.update",
        requestId: randomUUID(),
        payload: { id: initiative.id, expectedRevision: 2, preferences: { mcpServers: malformed } },
      }).success, JSON.stringify(malformed)).toBe(false);
    }
    // Nothing in the database could ever hold a value: entries only say "secret".
    const files = readdirSync(root).filter((name) => name.startsWith("inertia.sqlite"));
    for (const name of files) expect(readFileSync(join(root, name)).includes(SECRET)).toBe(false);
  });

  it("clears new secret slots before saving and forgets removed ones afterwards", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run, reference } = fixture(broker);
    // A stale vault entry for a slot that is about to be added must not be reused.
    broker.values.set(reference(tracker(), "Authorization"), "stale-secret");
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker()] } });
    expect(broker.forgotten).toEqual([reference(tracker(), "Authorization")]);
    expect(broker.values.size).toBe(0);

    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    broker.forgotten.length = 0;
    // Toggling, renaming and plain header values keep the secret.
    const edited = tracker({
      enabled: false,
      name: "issues",
      transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", secret: true }, { name: "X-Team", value: "billing" }] },
    });
    await run("initiative.update", { id: initiative.id, expectedRevision: 2, preferences: { mcpServers: [edited] } });
    expect(broker.forgotten).toEqual([]);
    expect(broker.values.get(reference(tracker(), "Authorization"))).toBe(SECRET);

    // Removing the server forgets its secret after the change is saved.
    await run("initiative.update", { id: initiative.id, expectedRevision: 3, preferences: { mcpServers: [] } });
    expect(store.initiatives.get(initiative.id)!.preferences.mcpServers).toEqual([]);
    expect(broker.forgotten).toEqual([reference(tracker(), "Authorization")]);
    expect(broker.values.size).toBe(0);
  });

  it("never lets a moved server reach the secrets entered for its old URL or command", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run, reference } = fixture(broker);
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker(), docs()] } });
    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    broker.values.set(reference(docs(), "DOCS_TOKEN"), ENV_SECRET);
    // Moving keeps the server's identity; its old secrets are forgotten and
    // the new destination's slots start empty.
    const moved = tracker({ transport: { kind: "http", url: "https://attacker.example.com/mcp", headers: [{ name: "Authorization", secret: true }] } });
    const otherProgram = docs({ transport: { kind: "stdio", command: "npx", args: ["-y", "@evil/mcp"], env: [{ name: "DOCS_TOKEN", secret: true }] } });
    broker.values.set(reference(moved, "Authorization"), "stale-value-for-new-url");
    broker.forgotten.length = 0;
    expect(await run("initiative.update", { id: initiative.id, expectedRevision: 2, preferences: { mcpServers: [moved, otherProgram] } }))
      .toMatchObject({ type: "request.ok" });
    expect(store.initiatives.get(initiative.id)!.preferences.mcpServers).toEqual([moved, otherProgram]);
    expect(broker.values.size).toBe(0);
    expect(broker.forgotten.sort()).toEqual([
      reference(tracker(), "Authorization"),
      reference(docs(), "DOCS_TOKEN"),
      reference(moved, "Authorization"),
      reference(otherProgram, "DOCS_TOKEN"),
    ].sort());
    // A plan for the moved servers resolves nothing: their secrets must be entered again.
    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    const resolved = await createInitiativeMcpResolver(broker)(
      { initiativeId: initiative.id, servers: [moved, otherProgram] },
      { signal: new AbortController().signal },
    );
    expect(resolved.servers).toEqual([]);
    expect(resolved.omitted.map(({ name }) => name)).toEqual(["tracker", "docs"]);
    // A new plain variable also changes a command server's destination.
    await run("initiative.update", { id: initiative.id, expectedRevision: 3, preferences: { mcpServers: [docs()] } });
    broker.values.set(reference(docs(), "DOCS_TOKEN"), ENV_SECRET);
    const redirected = docs({ transport: { ...docs().transport, env: [{ name: "DOCS_TOKEN", secret: true }, { name: "DOCS_URL", value: "https://evil.example.com" }] } as InitiativeMcpServer["transport"] });
    await run("initiative.update", { id: initiative.id, expectedRevision: 4, preferences: { mcpServers: [redirected] } });
    expect(broker.values.has(reference(docs(), "DOCS_TOKEN"))).toBe(false);
  });

  it("refuses the change when new slots cannot be cleared and leaves the stored servers alone", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run } = fixture(broker);
    broker.failForget = true;
    expect(await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker()] } }))
      .toMatchObject({ type: "request.error", message: expect.stringContaining("Secure credential storage is unavailable") });
    expect(store.initiatives.get(initiative.id)).toMatchObject({ revision: 1, preferences: { mcpServers: [] } });
    // A server without secrets needs no vault.
    expect(await run("initiative.update", {
      id: initiative.id, expectedRevision: 1,
      preferences: { mcpServers: [tracker({ transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [] } })] },
    })).toMatchObject({ type: "request.ok" });
  });

  it("forgets every secret of a deleted initiative", async () => {
    const broker = new FakeBroker();
    const { initiative, run, reference } = fixture(broker);
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker(), docs()] } });
    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    broker.values.set(reference(docs(), "DOCS_TOKEN"), ENV_SECRET);
    broker.forgotten.length = 0;
    await run("initiative.delete", { id: initiative.id });
    expect(broker.forgotten.sort()).toEqual([
      reference(tracker(), "Authorization"),
      reference(docs(), "DOCS_TOKEN"),
    ].sort());
    expect(broker.values.size).toBe(0);
  });

  it("tries a failed removal again, then keeps it for the next start", async () => {
    const broker = new FakeBroker();
    const { root, store, initiative, run, reference, pending } = fixture(broker);
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker(), docs()] } });
    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    broker.values.set(reference(docs(), "DOCS_TOKEN"), ENV_SECRET);
    // One failure is retried at once.
    broker.failForget = 1;
    broker.forgetAttempts = 0;
    expect(await run("initiative.update", { id: initiative.id, expectedRevision: 2, preferences: { mcpServers: [docs()] } }))
      .toMatchObject({ type: "request.ok" });
    expect(broker.forgetAttempts).toBe(2);
    expect(broker.values.has(reference(tracker(), "Authorization"))).toBe(false);
    expect(pending.list()).toEqual([]);

    // Two failures leave the reference in the pending list; the change still applies.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    broker.failForget = true;
    expect(await run("initiative.delete", { id: initiative.id })).toMatchObject({ type: "request.ok" });
    expect(store.initiatives.get(initiative.id)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be removed from secure storage"));
    expect(pending.list()).toEqual([reference(docs(), "DOCS_TOKEN")]);
    expect(readFileSync(join(root, "initiative-mcp-pending-forgets.json"), "utf8")).not.toContain(ENV_SECRET);

    // The next start removes it and empties the list.
    broker.failForget = false;
    await retryPendingInitiativeMcpForgets(broker, store, initiativeMcpPendingForgets(root));
    expect(broker.values.size).toBe(0);
    expect(pending.list()).toEqual([]);
    expect(existsSync(join(root, "initiative-mcp-pending-forgets.json"))).toBe(false);
  });

  it("never removes a pending reference that a stored initiative uses again", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run, reference, pending } = fixture(broker);
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker()] } });
    broker.values.set(reference(tracker(), "Authorization"), SECRET);
    broker.forgotten.length = 0;
    pending.add([reference(tracker(), "Authorization"), "secret:mcp:" + "a".repeat(64)]);
    await retryPendingInitiativeMcpForgets(broker, store, pending);
    expect(broker.values.get(reference(tracker(), "Authorization"))).toBe(SECRET);
    expect(broker.forgotten).toEqual(["secret:mcp:" + "a".repeat(64)]);
    expect(pending.list()).toEqual([]);
    // Clearing a slot that is added again also takes it off the list.
    pending.add([reference(docs(), "DOCS_TOKEN")]);
    await run("initiative.update", { id: initiative.id, expectedRevision: 2, preferences: { mcpServers: [tracker(), docs()] } });
    expect(pending.list()).toEqual([]);
  });

  it("leaves a pending reference alone once a change made during the retry uses it again", async () => {
    const broker = new FakeBroker();
    const { store, initiative, run, reference, pending } = fixture(broker);
    const orphan = `secret:mcp:${"b".repeat(64)}`;
    pending.add([orphan, reference(tracker(), "Authorization")]);
    // While the retry removes the first reference, the user adds the server
    // back and enters its secret: the second reference is in use again.
    const forget = broker.forget.bind(broker);
    let readded = false;
    broker.forget = async (target) => {
      if (target === orphan && !readded) {
        readded = true;
        await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker()] } });
        broker.values.set(reference(tracker(), "Authorization"), SECRET);
        broker.forgotten.length = 0;
      }
      return await forget(target);
    };
    await retryPendingInitiativeMcpForgets(broker, store, pending);
    expect(broker.forgotten).toEqual([orphan]);
    expect(broker.values.get(reference(tracker(), "Authorization"))).toBe(SECRET);
    expect(pending.list()).toEqual([]);
  });

  it("keeps the pending list small, valid and inside the data folder", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-initiative-mcp-pending-"));
    roots.push(root);
    const references = Array.from({ length: MAX_PENDING_INITIATIVE_MCP_FORGETS + 10 }, (_, index) =>
      `secret:mcp:${index.toString(16).padStart(64, "0")}`);
    writePendingInitiativeMcpForgets(root, [...references, "secret:backend:abc", "not a reference"]);
    const stored = readPendingInitiativeMcpForgets(root);
    expect(stored).toHaveLength(MAX_PENDING_INITIATIVE_MCP_FORGETS);
    expect(stored.at(-1)).toBe(references.at(-1));
    expect(stored.every((reference) => reference.startsWith("secret:mcp:"))).toBe(true);
  });
});

describe("initiative MCP servers in turn preparation", () => {
  function prepare(store: RuntimeStore, conversationId: string, providerId: "codex" | "claude" = "codex") {
    const selection = providerNativeModelSelection({ providerId, modelId: "provider-default" });
    store.updateConversation(conversationId, { modelSelection: selection });
    const route = resolveNativeModelRoute(selection);
    return resolveTurnRequest({
      store,
      providers: { resolveModelRoute: () => route, harnessIdFor: () => route.harnessId } as unknown as TurnProviderRuntime,
      hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [] },
      id: () => randomUUID(),
      now: () => new Date().toISOString(),
      clock: () => new Date(),
    }, { conversationId, content: "Continue." } as QueueTurnRequest);
  }

  it("fills the plan only for member chats of a non-archived initiative with enabled servers", async () => {
    const { store, project, initiative, run } = fixture(new FakeBroker());
    const member = store.createConversation(project.id, "Member", { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    const outsider = store.createConversation(project.id, "Outsider", { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }) });
    store.initiatives.assignConversation(member.id, initiative.id);
    const providerInputFor = (conversationId: string) => {
      const prepared = prepare(store, conversationId);
      return { prepared, providerInput: prepared.adopt(store.beginAgentTurn(prepared.input)).active.providerInput };
    };
    // No servers yet: nothing, and the request is unchanged.
    expect(providerInputFor(member.id).providerInput).not.toHaveProperty("initiativeMcpServers");

    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker(), docs({ enabled: false })] } });
    const { prepared, providerInput } = providerInputFor(member.id);
    expect(providerInput.initiativeMcpServers).toEqual({ initiativeId: initiative.id, servers: [tracker()] });
    // The persisted turn input never carries the servers.
    expect(JSON.stringify(prepared.input)).not.toContain("mcp.example.com");
    expect(providerInputFor(outsider.id).providerInput).not.toHaveProperty("initiativeMcpServers");
  });

  it("follows the initiative's status and the route's support", async () => {
    const { store, project, initiative, run } = fixture(new FakeBroker());
    await run("initiative.update", { id: initiative.id, expectedRevision: 1, preferences: { mcpServers: [tracker()] } });
    const member = store.createConversation(project.id, "Member");
    store.initiatives.assignConversation(member.id, initiative.id);
    const plan = (harnessId: string) => initiativeMcpServerPlan(store, store.conversation(member.id), harnessId);
    for (const harnessId of ["codex-app-server", "claude-agent-sdk", "cursor-acp", "kimi-acp", "opencode-sdk"]) {
      expect(plan(harnessId), harnessId).toEqual({ initiativeId: initiative.id, servers: [tracker()] });
    }
    for (const harnessId of ["antigravity-cli", "codex-cli", "claude-cli", "cursor-cli", "opencode-cli"]) {
      expect(plan(harnessId), harnessId).toBeUndefined();
    }
    store.initiatives.update(initiative.id, 2, { status: "done" });
    expect(plan("codex-app-server")).toBeDefined();
    store.initiatives.update(initiative.id, 3, { status: "archived" });
    expect(plan("codex-app-server")).toBeUndefined();
    expect(initiativeMcpServerPlan(store, { initiativeId: null }, "codex-app-server")).toBeUndefined();
    expect(initiativeMcpServerPlan(store, { initiativeId: randomUUID() }, "codex-app-server")).toBeUndefined();
  });
});

describe("initiative MCP secret resolution", () => {
  const plan = (initiativeId: string): ProviderInitiativeMcpPlan => ({ initiativeId, servers: [tracker(), docs()] });

  it("resolves secrets in memory, leaving out a server whose secret is missing", async () => {
    const broker = new FakeBroker();
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), `Bearer ${SECRET}`);
    const resolved = await createInitiativeMcpResolver(broker)(plan(initiativeId), { signal: new AbortController().signal });
    expect(resolved.servers).toEqual([{
      name: "tracker",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", value: `Bearer ${SECRET}`, secret: true }, { name: "X-Team", value: "checkout" }],
    }]);
    expect(resolved.secrets).toEqual([`Bearer ${SECRET}`, SECRET]);
    expect(resolved.omitted).toEqual([{ name: "docs", reason: "The secret “DOCS_TOKEN” is not set. Set it on the Initiative page." }]);
  });

  it("never sends a stored secret too short to redact", async () => {
    const broker = new FakeBroker();
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), "Bearer 1234567");
    broker.values.set(secretReference(initiativeId, docs(), "DOCS_TOKEN"), "x");
    const resolved = await createInitiativeMcpResolver(broker)(plan(initiativeId), { signal: new AbortController().signal });
    expect(resolved).toEqual({
      servers: [],
      secrets: [],
      omitted: [
        { name: "tracker", reason: "The secret “Authorization” must be entered again on the Initiative page." },
        { name: "docs", reason: "The secret “DOCS_TOKEN” must be entered again on the Initiative page." },
      ],
    });
  });

  it("leaves servers out when the vault cannot be read and stops on cancellation", async () => {
    const broker = new FakeBroker();
    broker.failResolve = true;
    const initiativeId = randomUUID();
    const unavailable = await createInitiativeMcpResolver(broker)(plan(initiativeId), { signal: new AbortController().signal });
    expect(unavailable.servers).toEqual([]);
    expect(unavailable.omitted.map(({ reason }) => reason)).toEqual([
      "Secure credential storage is unavailable.",
      "Secure credential storage is unavailable.",
    ]);
    expect(await createInitiativeMcpResolver(undefined)(plan(initiativeId), { signal: new AbortController().signal }))
      .toMatchObject({ servers: [], secrets: [] });
    const aborted = new AbortController();
    aborted.abort();
    await expect(createInitiativeMcpResolver(broker)(plan(initiativeId), { signal: aborted.signal })).rejects.toThrow();
    // A server without secrets needs nothing from the vault.
    const plain = await createInitiativeMcpResolver(undefined)({
      initiativeId,
      servers: [docs({ transport: { kind: "stdio", command: "/usr/local/bin/docs", args: [], env: [{ name: "REGION", value: "eu" }] } })],
    }, { signal: new AbortController().signal });
    expect(plain.servers).toEqual([{ name: "docs", transport: "stdio", command: "/usr/local/bin/docs", args: [], env: [{ name: "REGION", value: "eu" }] }]);
  });
});

describe("initiative MCP servers at provider launch", () => {
  type HarnessScript = (
    emitter: ReturnType<typeof createAgentHarnessEmitter>,
    start: AgentHarnessStartOptions,
  ) => Partial<ProviderRunResult> | Error;

  function launch(options: {
    echoSecret?: boolean;
    script?: HarnessScript;
    resolve?: (plan: ProviderInitiativeMcpPlan) => Promise<{ servers: never[] } | Awaited<ReturnType<ReturnType<typeof createInitiativeMcpResolver>>>>;
  } = {}) {
    const captures: AgentHarnessStartOptions[] = [];
    const events: unknown[] = [];
    const harness: AgentHarness = {
      id: "claude-cli",
      providerId: "claude",
      capabilities: PROCESS_LIFECYCLE_CAPABILITIES_FOR_TESTS.claude,
      supports: () => true,
      start: (start) => {
        captures.push(start);
        const emitter = createAgentHarnessEmitter("claude", start.input.conversationId, start.callbacks, start.input.runId, start.input.turnId);
        const leaked = options.echoSecret ? ` ${SECRET}` : "";
        const scripted = options.script?.(emitter, start);
        if (!options.script) {
          emitter.activity("tool", "failed", `MCP tracker said${leaked}`, { detail: `Authorization: Bearer${leaked}` });
        }
        return {
          harnessId: "claude-cli",
          providerId: "claude",
          result: scripted instanceof Error ? Promise.reject(scripted) : Promise.resolve({
            ...providerRunTerminal(start.input, options.echoSecret ? "failed" : "completed"),
            text: `done${leaked}`,
            textTruncated: false,
            exitCode: 0,
            signal: null,
            ...(options.echoSecret ? { error: `provider failed${leaked}` } : {}),
            cleanupConfirmed: true,
            ...scripted,
          }),
          cancel: () => undefined,
          extension: { kind: "cli", providerId: "claude" },
        };
      },
    };
    const broker = new FakeBroker();
    const resolver = createInitiativeMcpResolver(broker);
    const manager = ProviderManager.createForTests(
      { cancelGraceMs: 100, resolveInitiativeMcpServers: options.resolve as never ?? resolver },
      new AgentHarnessRegistry([harness]),
    );
    const input = (overrides: Partial<ProviderRunInput> = {}): ProviderRunInput => ({
      ...nativeProviderRunFields("claude", "provider-default", "", "claude-cli"),
      conversationId: "mcp-launch",
      runId: `run-${randomUUID()}`,
      turnId: `turn-${randomUUID()}`,
      cwd: "/workspace",
      prompt: "Use the tracker",
      interactionMode: "build",
      access: "supervised",
      ...overrides,
    } as ProviderRunInput);
    return { manager, captures, events, broker, input };
  }

  it("gives only the harness's copy the resolved servers, and reports servers it left out", async () => {
    const { manager, captures, broker, input } = launch();
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), `Bearer ${SECRET}`);
    const request = input({ initiativeMcpServers: { initiativeId, servers: [tracker(), docs()] } });
    const activities: string[] = [];
    await manager.run(request, { onActivity: (event) => { activities.push(event.label); } });
    expect(captures[0]!.input.mcpServers).toEqual([expect.objectContaining({ name: "tracker", url: "https://mcp.example.com/mcp" })]);
    expect(JSON.stringify(captures[0]!.input.mcpServers)).toContain(SECRET);
    // The caller's request keeps only the unresolved plan.
    expect(request).not.toHaveProperty("mcpServers");
    expect(JSON.stringify(request)).not.toContain(SECRET);
    expect(activities).toContain("Initiative MCP server not added · docs");
    await manager.disposeAll();
  });

  it("redacts resolved secrets from every event, the result and failures", async () => {
    const { manager, broker, input } = launch({ echoSecret: true });
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), `Bearer ${SECRET}`);
    const seen: unknown[] = [];
    const result = await manager.run(
      input({ initiativeMcpServers: { initiativeId, servers: [tracker()] } }),
      { onEvent: (event) => { seen.push(event); } },
    );
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).toContain("[secret]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.error).toBe("provider failed [secret]");
    await manager.disposeAll();
  });

  it("never rewrites identities, even when a secret occurs inside them", async () => {
    // A secret that also appears in the run's own identities and in the ids
    // the provider assigns: only text fields may change.
    const idSecret = `ids${randomUUID().slice(0, 8)}`;
    const { manager, broker, input } = launch({
      script: (emitter) => {
        emitter.session(`session-${idSecret}`);
        emitter.activity("tool", "started", `Calling ${idSecret}`, { activityId: `call-${idSecret}`, detail: `token ${idSecret}` });
        emitter.text(`Answer with ${idSecret}.`);
        return { sessionId: `session-${idSecret}`, text: `Answer with ${idSecret}.` };
      },
    });
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), idSecret);
    const request = input({
      conversationId: `chat-${idSecret}`,
      runId: `run-${idSecret}`,
      turnId: `turn-${idSecret}`,
      initiativeMcpServers: { initiativeId, servers: [tracker()] },
    });
    const seen: Array<Record<string, unknown>> = [];
    const result = await manager.run(request, { onEvent: (event) => { seen.push(event as never); } });
    expect(result).toMatchObject({
      status: "completed",
      conversationId: `chat-${idSecret}`,
      runId: `run-${idSecret}`,
      turnId: `turn-${idSecret}`,
      sessionId: `session-${idSecret}`,
      text: "Answer with [secret].",
    });
    for (const event of seen) {
      expect(event).toMatchObject({ conversationId: `chat-${idSecret}`, runId: `run-${idSecret}`, turnId: `turn-${idSecret}` });
    }
    expect(seen.find((event) => event.type === "session")).toMatchObject({ sessionId: `session-${idSecret}` });
    expect(seen.find((event) => event.type === "activity" && event.label !== undefined && String(event.label).startsWith("Calling")))
      .toMatchObject({ activityId: `call-${idSecret}`, label: "Calling [secret]", detail: "token [secret]" });
    expect(seen.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("Answer with [secret].");
    await manager.disposeAll();
  });

  it("keeps a result within the harness's output limit after redaction", async () => {
    const limit = 64 * 1024;
    const filler = `${SECRET} `.repeat(Math.ceil(limit / (SECRET.length + 1)));
    const raw = filler.slice(0, limit);
    const { manager, broker, input } = launch({
      script: () => ({ text: raw, textTruncated: true, status: "failed", terminalReason: { outcome: "failed", reason: "provider-error" },
        error: raw, failure: { reason: "provider-error", message: raw, technicalDetail: raw } }),
    });
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), SECRET);
    const result = await manager.run(input({ initiativeMcpServers: { initiativeId, servers: [tracker()] } }));
    for (const value of [result.text, result.error!, result.failure!.message, result.failure!.technicalDetail!]) {
      expect(value).not.toContain(SECRET);
      expect(value).toContain("[secret]");
      expect(value.length).toBeLessThanOrEqual(raw.length);
    }
    expect(result.textTruncated).toBe(true);
    await manager.disposeAll();
  });

  it("redacts a failure's message and stack", async () => {
    const failure = new Error(`provider crashed with ${SECRET}`);
    failure.stack = `Error: provider crashed with ${SECRET}\n    at provider (${SECRET}.js:1:1)`;
    const { manager, broker, input } = launch({ script: () => failure });
    const initiativeId = randomUUID();
    broker.values.set(secretReference(initiativeId, tracker(), "Authorization"), `Bearer ${SECRET}`);
    const run = manager.run(input({ initiativeMcpServers: { initiativeId, servers: [tracker()] } }));
    const error = await run.then(() => new Error("The run did not fail."), (caught: unknown) => caught as Error);
    expect(error).toBe(failure);
    expect(error.message).toBe("provider crashed with [secret]");
    expect(error.stack).not.toContain(SECRET);
    expect(error.stack).toContain("[secret].js");
    // A harness whose result failed leaves its cleanup unconfirmed by design.
    await manager.disposeAll().catch(() => undefined);
  });

  it("refuses a request that arrives with resolved servers", () => {
    const { manager, input } = launch();
    expect(() => manager.run(input({
      mcpServers: [{ name: "tracker", transport: "http", url: "https://mcp.example.com/mcp", headers: [] }],
    }))).toThrow("Resolved MCP servers can only come from Inertia's launch step.");
  });

  it("starts without servers and never consults the vault for chats without a plan", async () => {
    const resolve = vi.fn();
    const { manager, captures, input } = launch({ resolve });
    await manager.run(input());
    expect(resolve).not.toHaveBeenCalled();
    expect(captures[0]!.input).not.toHaveProperty("mcpServers");
    await manager.disposeAll();
  });
});
