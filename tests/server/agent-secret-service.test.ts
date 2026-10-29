import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { ProviderHostToolCall, ProviderHostToolResult } from "../../src/server/provider/contracts";
import { AgentSecretService } from "../../src/server/runtime/agent-secrets/agent-secret-service";
import { agentSecretRoot } from "../../src/server/runtime/agent-secrets/secret-files";
import { agentSecretReference, SECRET_REQUEST_TOOL_NAME } from "../../src/shared/agent-secrets";
import type { RuntimeMutationEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const SECRET = "tskey-auth-kQ9xZ2mB7vN4pL1sR8tW";
const POSIX = process.platform !== "win32";
const directories: string[] = [];
const stores: RuntimeStore[] = [];
const services: AgentSecretService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.shutdown();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Harness {
  directory: string;
  store: RuntimeStore;
  service: AgentSecretService;
  events: RuntimeMutationEvent[];
  waits: Array<[string, string, string, string | null]>;
  forgotten: string[];
  clock: { now: number };
  resolveVault: ReturnType<typeof vi.fn>;
}

async function openHarness(options: {
  directory?: string;
  waitMs?: number;
  vault?: Record<string, string>;
  start?: boolean;
} = {}): Promise<Harness> {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "inertia-secret-service-"));
  if (!options.directory) directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  if (store.shellSnapshot().projects.length === 0) store.createProject("Secrets", workspace);
  const events: RuntimeMutationEvent[] = [];
  const waits: Harness["waits"] = [];
  const forgotten: string[] = [];
  const clock = { now: Date.parse("2026-10-29T12:00:00.000Z") };
  const vault = options.vault ?? {};
  const resolveVault = vi.fn(async (reference: string) => vault[reference] ?? null);
  const service = new AgentSecretService({
    store,
    dataDirectory: directory,
    turns: {
      secretWait: (conversationId, turnId, requestId, title) => {
        waits.push([conversationId, turnId, requestId, title]);
        return true;
      },
    },
    broadcast: (event) => events.push(event),
    credentials: {
      resolve: resolveVault,
      forget: async (reference) => {
        forgotten.push(reference);
        return true;
      },
    },
    clock: () => clock.now,
    platform: "linux",
    waitMs: () => options.waitMs ?? 60_000,
  });
  services.push(service);
  if (options.start !== false) service.start();
  return { directory, store, service, events, waits, forgotten, clock, resolveVault };
}

function chat(store: RuntimeStore, title = "Tailscale") {
  const project = store.shellSnapshot().projects[0]!;
  const conversation = store.createConversation(project.id, title, {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const turn = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: randomUUID(),
    content: "Set up the test VMs.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  return { conversation, turn };
}

function call(argumentsValue: unknown, signal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "thread",
    providerTurnId: "turn",
    toolCallId: randomUUID(),
    tool: SECRET_REQUEST_TOOL_NAME,
    arguments: argumentsValue,
    signal,
    requestApproval: async () => "approve",
  };
}

const VALID = {
  title: "Tailscale auth key",
  description: "Create a reusable, ephemeral key at login.tailscale.com/admin/settings/keys.",
  fileName: "tailscale-authkey",
  ttlHours: 6,
};

function pendingId(store: RuntimeStore): string {
  const [pending] = store.agentSecretRequests().pendingAll();
  if (!pending) throw new Error("No pending secret request.");
  return pending.id;
}

function parsed(result: ProviderHostToolResult): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("agent secret service: pending request, private file and turn wait", () => {
  it("writes the delivered value to an owner-only file in a fresh token directory and returns its path and expiry", async () => {
    const harness = await openHarness();
    const { conversation, turn } = chat(harness.store);
    const result = harness.service.invoke({ conversation, turn }, call(VALID));
    const requestId = pendingId(harness.store);
    expect(harness.waits).toEqual([[conversation.id, turn.id, requestId, VALID.title]]);
    const persisted = harness.events.find((event) => event.type === "conversation.message.persisted");
    expect(persisted).toMatchObject({ message: { role: "system", secretRequest: { requestId, status: "pending" } } });

    const delivered = await harness.service.deliver({ conversationId: conversation.id, requestId, secret: SECRET, vaulted: true });
    expect(delivered).toEqual({ status: "delivered", expiresAt: "2026-10-29T18:00:00.000Z", storage: "keychain" });
    const outcome = await result;
    const body = parsed(outcome);
    expect(outcome.success).toBe(true);
    expect(body).toMatchObject({ status: "saved", secretId: `inertia-secret:${requestId}`, expiresAt: "2026-10-29T18:00:00.000Z" });
    const file = body.file as string;
    expect(body.use).toBe(`KEY="$(cat '${file}')"`);
    expect(outcome.text).not.toContain(SECRET);
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    const root = agentSecretRoot(harness.directory);
    const tokenDirectory = dirname(file);
    expect(dirname(tokenDirectory)).toBe(root);
    expect(tokenDirectory.slice(root.length + 1)).toMatch(/^[0-9a-f]{32}$/u);
    expect(tokenDirectory).not.toContain(requestId);
    expect(file.endsWith("/tailscale-authkey") || file.endsWith("\\tailscale-authkey")).toBe(true);
    expect(readdirSync(tokenDirectory)).toEqual(["tailscale-authkey"]);
    if (POSIX) {
      expect(mode(root)).toBe(0o700);
      expect(mode(tokenDirectory)).toBe(0o700);
      expect(mode(file)).toBe(0o600);
    }
    expect(harness.waits.at(-1)).toEqual([conversation.id, turn.id, requestId, null]);
    const record = harness.store.agentSecretRequests().find(requestId)!;
    expect(record).toMatchObject({ status: "saved", vaulted: true, expiresAt: "2026-10-29T18:00:00.000Z" });
    expect(JSON.stringify(harness.events)).not.toContain(SECRET);
    expect(JSON.stringify(harness.events)).not.toContain(tokenDirectory);
    expect(harness.service.output.values()).toContain(SECRET);
    expect(harness.service.list()).toEqual([{
      requestId,
      conversationId: conversation.id,
      conversationTitle: "Tailscale",
      title: VALID.title,
      answeredAt: "2026-10-29T12:00:00.000Z",
      expiresAt: "2026-10-29T18:00:00.000Z",
      storage: "keychain",
    }]);
    expect(JSON.stringify(harness.service.list())).not.toContain(file);
  });

  it("quotes the path for POSIX shells and PowerShell", async () => {
    const { secretFileUseExample } = await import("../../src/server/runtime/agent-secrets/secret-request-host-tool");
    expect(secretFileUseExample("/home/o'neil/Application Support/x/secret", "darwin"))
      .toBe("KEY=\"$(cat '/home/o'\\''neil/Application Support/x/secret')\"");
    expect(secretFileUseExample("C:\\Users\\o'neil\\secret", "win32"))
      .toBe("$key = Get-Content -Raw 'C:\\Users\\o''neil\\secret'");
  });

  it("declines, forgets any vault copy, and refuses a late delivery", async () => {
    const harness = await openHarness();
    const { conversation, turn } = chat(harness.store);
    const result = harness.service.invoke({ conversation, turn }, call(VALID));
    const requestId = pendingId(harness.store);
    expect(await harness.service.decline(randomUUID(), requestId)).toBe(false);
    expect(await harness.service.decline(conversation.id, requestId)).toBe(true);
    expect(await harness.service.decline(conversation.id, requestId)).toBe(false);
    const outcome = await result;
    expect(parsed(outcome)).toEqual({
      status: "declined",
      message: "The user declined. Continue without it, or explain in chat why you need it.",
    });
    expect(harness.forgotten).toContain(agentSecretReference(requestId));
    expect(await harness.service.deliver({ conversationId: conversation.id, requestId, secret: SECRET, vaulted: true }))
      .toEqual({ status: "rejected", reason: "not-pending" });
    expect(harness.store.agentSecretRequests().find(requestId)?.status).toBe("declined");
    expect(readdirSync(agentSecretRoot(harness.directory))).toEqual([]);
  });

  it("ends on abort and on timeout, and a delivery after the timeout is not pending", async () => {
    const harness = await openHarness({ waitMs: 20 });
    const first = chat(harness.store, "Abort");
    const controller = new AbortController();
    const aborted = harness.service.invoke(first, call(VALID, controller.signal));
    const abortedId = pendingId(harness.store);
    controller.abort();
    expect(parsed(await aborted)).toEqual({
      status: "ended", reason: "cancelled", message: "No answer arrived. Ask again only if still needed.",
    });
    expect(harness.store.agentSecretRequests().find(abortedId)?.status).toBe("ended");
    expect(harness.forgotten).toContain(agentSecretReference(abortedId));

    const second = chat(harness.store, "Timeout");
    const timedOut = harness.service.invoke(second, call(VALID));
    const timedOutId = pendingId(harness.store);
    expect(parsed(await timedOut)).toMatchObject({ status: "ended", reason: "timed_out" });
    expect(await harness.service.deliver({ conversationId: second.conversation.id, requestId: timedOutId, secret: SECRET, vaulted: false }))
      .toEqual({ status: "rejected", reason: "not-pending" });
    expect(harness.waits.filter(([, , id, title]) => id === timedOutId && title === null)).toHaveLength(1);
  });

  it("lets exactly one of two concurrent deliveries win", async () => {
    const harness = await openHarness();
    const { conversation, turn } = chat(harness.store);
    const result = harness.service.invoke({ conversation, turn }, call(VALID));
    const requestId = pendingId(harness.store);
    const outcomes = await Promise.all([
      harness.service.deliver({ conversationId: conversation.id, requestId, secret: SECRET, vaulted: true }),
      harness.service.deliver({ conversationId: conversation.id, requestId, secret: `${SECRET}-other`, vaulted: true }),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["delivered", "rejected"]);
    const file = parsed(await result).file as string;
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(readdirSync(agentSecretRoot(harness.directory))).toHaveLength(1);
  });

  it("refuses a delivery for another conversation", async () => {
    const harness = await openHarness();
    const { conversation, turn } = chat(harness.store);
    const result = harness.service.invoke({ conversation, turn }, call(VALID));
    const requestId = pendingId(harness.store);
    expect(await harness.service.deliver({ conversationId: randomUUID(), requestId, secret: SECRET, vaulted: true }))
      .toEqual({ status: "rejected", reason: "not-pending" });
    await harness.service.decline(conversation.id, requestId);
    await result;
  });

  it("expires and revokes: the file goes, the vault is forgotten and the value is no longer redacted", async () => {
    const harness = await openHarness();
    const first = chat(harness.store, "Expiring");
    const firstResult = harness.service.invoke(first, call({ ...VALID, ttlHours: 1 }));
    const firstId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: first.conversation.id, requestId: firstId, secret: SECRET, vaulted: true });
    const firstFile = parsed(await firstResult).file as string;
    const second = chat(harness.store, "Revoked");
    const secondResult = harness.service.invoke(second, call(VALID));
    const secondId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: second.conversation.id, requestId: secondId, secret: "ghp_revokedValue1234", vaulted: false });
    const secondFile = parsed(await secondResult).file as string;

    harness.clock.now += 60 * 60_000;
    harness.service.sweep();
    expect(existsSync(firstFile)).toBe(false);
    expect(existsSync(dirname(firstFile))).toBe(false);
    expect(harness.store.agentSecretRequests().find(firstId)?.status).toBe("expired");
    expect(harness.forgotten).toContain(agentSecretReference(firstId));
    expect(harness.service.output.values()).not.toContain(SECRET);
    expect(existsSync(secondFile)).toBe(true);

    expect(await harness.service.revoke(secondId)).toBe(true);
    expect(await harness.service.revoke(secondId)).toBe(false);
    expect(existsSync(dirname(secondFile))).toBe(false);
    expect(harness.store.agentSecretRequests().find(secondId)?.status).toBe("revoked");
    expect(harness.forgotten).toContain(agentSecretReference(secondId));
    expect(harness.service.output.values()).toEqual([]);
    expect(harness.service.output.text("ghp_revokedValue1234")).toBe("ghp_revokedValue1234");
    expect(harness.service.list()).toEqual([]);
    const revokedMessage = harness.events.filter((event) => event.type === "conversation.message.persisted").at(-1);
    expect(revokedMessage).toMatchObject({ message: { secretRequest: { requestId: secondId, status: "revoked" } } });
  });

  it("deletes every file at shutdown and ends a pending request as stopped", async () => {
    const harness = await openHarness();
    const saved = chat(harness.store, "Saved");
    const savedResult = harness.service.invoke(saved, call(VALID));
    await harness.service.deliver({ conversationId: saved.conversation.id, requestId: pendingId(harness.store), secret: SECRET, vaulted: true });
    await savedResult;
    const waiting = chat(harness.store, "Waiting");
    const waitingResult = harness.service.invoke(waiting, call(VALID));
    const waitingId = pendingId(harness.store);
    harness.service.shutdown();
    expect(parsed(await waitingResult)).toMatchObject({ status: "ended", reason: "stopped" });
    expect(harness.store.agentSecretRequests().find(waitingId)?.status).toBe("ended");
    expect(readdirSync(agentSecretRoot(harness.directory))).toEqual([]);
    expect(harness.service.output.values()).toEqual([]);
  });

  it("reconciles on startup: pending ends, expired and unvaulted expire, vaulted come back at the same path, strays go", async () => {
    const first = await openHarness();
    const { store, directory } = first;
    const make = async (title: string, vaulted: boolean, ttlHours: number) => {
      const source = chat(store, title);
      const result = first.service.invoke(source, call({ ...VALID, title, ttlHours }));
      const requestId = pendingId(store);
      await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: `${title}-value-1234`, vaulted });
      return { requestId, file: parsed(await result).file as string };
    };
    const restored = await make("Restored", true, 24);
    const missing = await make("Missing", true, 24);
    const memory = await make("Memory", false, 24);
    const expired = await make("Expired", true, 1);
    const pendingSource = chat(store, "Pending");
    void first.service.invoke(pendingSource, call(VALID));
    const pendingRequest = pendingId(store);
    first.service.shutdown();
    expect(store.agentSecretRequests().find(pendingRequest)?.status).toBe("ended");
    store.agentSecretRequests().create({
      conversationId: pendingSource.conversation.id,
      runId: pendingSource.turn.runId,
      turnId: pendingSource.turn.id,
      providerId: "codex",
      title: "Orphan",
      description: "Left pending by a crash.",
      fileName: "secret",
      ttlHours: 24,
    });
    const orphanId = pendingId(store);
    const stray = join(agentSecretRoot(directory), "ffffffffffffffffffffffffffffffff");
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, "secret"), "left behind");
    stores.splice(stores.indexOf(store), 1);
    store.close();

    const third = await openHarness({
      directory,
      vault: { [agentSecretReference(restored.requestId)]: "Restored-value-1234" },
      start: false,
    });
    third.clock.now = first.clock.now + 2 * 60 * 60_000;
    third.service.start();
    expect(existsSync(stray)).toBe(false);
    const requests = third.store.agentSecretRequests();
    expect(requests.find(orphanId)?.status).toBe("ended");
    expect(requests.find(memory.requestId)?.status).toBe("expired");
    expect(requests.find(expired.requestId)?.status).toBe("expired");
    await third.service.restore();
    expect(readFileSync(restored.file, "utf8")).toBe("Restored-value-1234");
    expect(requests.find(restored.requestId)?.status).toBe("saved");
    expect(requests.find(missing.requestId)?.status).toBe("expired");
    expect(third.forgotten).toEqual(expect.arrayContaining([
      agentSecretReference(missing.requestId),
      agentSecretReference(expired.requestId),
    ]));
    expect(third.service.output.values()).toContain("Restored-value-1234");
    expect(readdirSync(agentSecretRoot(directory))).toEqual([dirname(restored.file).slice(agentSecretRoot(directory).length + 1)]);
  });

  it("deletes a materialized file whose row disappeared with its conversation on the next sweep", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const result = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await result).file as string;
    harness.store.deleteConversation(source.conversation.id);
    harness.service.sweep();
    expect(existsSync(dirname(file))).toBe(false);
    expect(harness.service.output.values()).toEqual([]);
    expect(harness.forgotten).toContain(agentSecretReference(requestId));
  });
});

describe("agent secret service: limits and argument misuse", () => {
  it("allows one pending request per chat and three requests per turn", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const first = harness.service.invoke(source, call(VALID));
    const second = await harness.service.invoke(source, call(VALID));
    expect(second.success).toBe(false);
    expect(parsed(second)).toMatchObject({ error: { code: "secret_request_pending" } });
    expect(harness.store.agentSecretRequests().forConversation(source.conversation.id)).toHaveLength(1);
    await harness.service.decline(source.conversation.id, pendingId(harness.store));
    await first;
    for (let index = 0; index < 2; index += 1) {
      const pending = harness.service.invoke(source, call(VALID));
      await harness.service.decline(source.conversation.id, pendingId(harness.store));
      await pending;
    }
    const fourth = await harness.service.invoke(source, call(VALID));
    expect(parsed(fourth)).toMatchObject({ error: { code: "secret_request_limit" } });
    expect((parsed(fourth).error as { message: string }).message).toContain("3 secrets");
  });

  it("refuses a new request once 32 secrets are active", async () => {
    const harness = await openHarness();
    for (let index = 0; index < 32; index += 1) {
      const source = chat(harness.store, `Chat ${index}`);
      const pending = harness.service.invoke(source, call(VALID));
      const delivered = await harness.service.deliver({
        conversationId: source.conversation.id, requestId: pendingId(harness.store), secret: `value-${index}-abcd`, vaulted: false,
      });
      expect(delivered.status).toBe("delivered");
      await pending;
    }
    const refused = await harness.service.invoke(chat(harness.store, "One more"), call(VALID));
    expect(parsed(refused)).toMatchObject({ error: { code: "secret_limit" } });
    expect(harness.store.agentSecretRequests().pendingAll()).toEqual([]);
  });

  it.each([
    ["a 48-hour lifetime", { ...VALID, ttlHours: 48 }, "ttlHours"],
    ["a 900-character description", { ...VALID, description: "x".repeat(900) }, "description"],
    ["a path in the file name", { ...VALID, fileName: "../x" }, "fileName"],
    ["an 81-character title", { ...VALID, title: "t".repeat(81) }, "title"],
    ["an unknown argument", { ...VALID, value: "paste" }, "unexpected arguments: value"],
    ["a blank title", { ...VALID, title: "\u0007\u0007" }, "visible text"],
  ])("rejects %s without opening a card", async (_label, argumentsValue, mention) => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const result = await harness.service.invoke(source, call(argumentsValue));
    expect(result.success).toBe(false);
    expect(parsed(result)).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(result.text).toContain(mention);
    expect(result.text).not.toContain("\"path\"");
    expect(harness.store.agentSecretRequests().forConversation(source.conversation.id)).toEqual([]);
    expect(harness.waits).toEqual([]);
  });

  it("ends immediately when the turn is not active in the controller", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const refusing = new AgentSecretService({
      store: harness.store,
      dataDirectory: harness.directory,
      turns: { secretWait: () => false },
      broadcast: () => undefined,
      waitMs: () => 60_000,
    });
    services.push(refusing);
    const result = await refusing.invoke(source, call(VALID));
    expect(parsed(result)).toMatchObject({ status: "ended", reason: "cancelled" });
    expect(harness.store.agentSecretRequests().forConversation(source.conversation.id)[0]?.status).toBe("ended");
  });
});
