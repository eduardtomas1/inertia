import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { createConversationCommandHandler } from "../../src/server/runtime/commands/conversation-commands";
import type { ProviderHostToolCall, ProviderHostToolResult } from "../../src/server/provider/contracts";
import { AgentSecretService } from "../../src/server/runtime/agent-secrets/agent-secret-service";
import {
  SECRET_REQUEST_DECLINED_MESSAGE,
  SECRET_REQUEST_ENDED_MESSAGE,
} from "../../src/server/runtime/agent-secrets/secret-request-host-tool";
import {
  agentSecretRoot,
  ensureAgentSecretRoot,
  ensureAgentSecretRootAsync,
  removeAgentSecretDirectory,
  writeAgentSecretFile,
  type AgentSecretExecFileAsync,
  type AgentSecretExecFileSync,
  type WindowsDaclCache,
} from "../../src/server/runtime/agent-secrets/secret-files";
import { agentSecretReference, SECRET_REQUEST_TOOL_NAME } from "../../src/node/agent-secrets";
import type { RuntimeMutationEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const SECRET = "fake-token-kQ9xZ2mB7vN4pL1sR8tW";
const WIN32_TEST_ENV: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" };
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
  locked: Set<string>;
}

async function openHarness(options: {
  directory?: string;
  waitMs?: number;
  vault?: Record<string, string>;
  start?: boolean;
  resolve?: (reference: string) => Promise<string | null>;
  forget?: (reference: string) => Promise<boolean>;
  writeFile?: typeof writeAgentSecretFile;
  removeDirectory?: (root: string, token: string) => void;
  removeDirectoryAsync?: (root: string, token: string) => Promise<void>;
  ensureRoot?: typeof ensureAgentSecretRoot;
  ensureRootAsync?: typeof ensureAgentSecretRootAsync;
  sweepIntervalMs?: number;
  platform?: NodeJS.Platform;
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
  const resolveVault = vi.fn(options.resolve ?? (async (reference: string) => vault[reference] ?? null));
  const locked = new Set<string>();
  const service = new AgentSecretService({
    store,
    dataDirectory: directory,
    turns: {
      open: () => ({ notBefore: null }),
      wait: (conversationId, turnId, requestId, title) => {
        waits.push([conversationId, turnId, requestId, title]);
        return true;
      },
    },
    removeDirectory: options.removeDirectory ?? ((root, token) => {
      if (locked.has(token)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      removeAgentSecretDirectory(root, token);
    }),
    ...(options.removeDirectoryAsync ? { removeDirectoryAsync: options.removeDirectoryAsync } : {}),
    ...(options.sweepIntervalMs ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
    ...(options.writeFile ? { writeFile: options.writeFile } : {}),
    ...(options.ensureRoot ? { ensureRoot: options.ensureRoot } : {}),
    ...(options.ensureRootAsync ? { ensureRootAsync: options.ensureRootAsync } : {}),
    broadcast: (event) => events.push(event),
    credentials: {
      resolve: resolveVault,
      forget: async (reference) => {
        forgotten.push(reference);
        return await (options.forget?.(reference) ?? true);
      },
    },
    clock: () => clock.now,
    platform: options.platform ?? "linux",
    waitMs: () => options.waitMs ?? 60_000,
  });
  services.push(service);
  if (options.start !== false) service.start();
  return { directory, store, service, events, waits, forgotten, clock, resolveVault, locked };
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
  const [pending] = store.transcriptRepository.secretRequests.pendingAll();
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
  it.skipIf(!POSIX)("refuses a linked root without deleting or changing the target during start, sweep, shutdown or save", async () => {
    const harness = await openHarness({ start: false });
    const outside = join(harness.directory, "outside");
    const token = "a".repeat(32);
    await mkdir(join(outside, token), { recursive: true, mode: 0o755 });
    const sourceFile = join(outside, "source.ts");
    const secretFile = join(outside, token, "secret");
    await writeFile(sourceFile, "valuable project source");
    await writeFile(secretFile, "valuable token-directory file");
    const originalMode = mode(outside);
    const root = agentSecretRoot(harness.directory);
    symlinkSync(outside, root, "dir");
    harness.service.start();
    harness.service.sweep();
    await expect(writeAgentSecretFile(root, token, "secret", SECRET)).rejects.toThrow("real directory");
    harness.service.shutdown();
    expect(readFileSync(sourceFile, "utf8")).toBe("valuable project source");
    expect(readFileSync(secretFile, "utf8")).toBe("valuable token-directory file");
    expect(mode(outside)).toBe(originalMode);
  });

  it("refuses an active secret in request metadata before storing or broadcasting a new card", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    harness.service.output.setValues([SECRET]);
    const result = await harness.service.invoke(source, call({ ...VALID, description: `Use ${SECRET}` }));
    expect(parsed(result)).toMatchObject({ error: { code: "secret_value_not_allowed" } });
    expect(harness.store.transcriptRepository.secretRequests.pendingAll()).toEqual([]);
    expect(harness.events).toEqual([]);
    // Also catches secrets placed in object keys or nested past MAX_DEPTH.
    expect(harness.service.containsSecret({ answers: { [SECRET]: "ok" } })).toBe(true);
    let deep: unknown = { value: SECRET };
    for (let depth = 0; depth < 35; depth += 1) deep = { nested: deep };
    expect(harness.service.containsSecret(deep)).toBe(true);
  });

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
    const record = harness.store.transcriptRepository.secretRequests.find(requestId)!;
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
      .toBe("PowerShell: $key = Get-Content -Raw 'C:\\Users\\o''neil\\secret' | Git Bash: KEY=\"$(cat 'C:\\Users\\o'\\''neil\\secret')\"");
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
      message: SECRET_REQUEST_DECLINED_MESSAGE,
    });
    expect(harness.forgotten).toContain(agentSecretReference(requestId));
    expect(await harness.service.deliver({ conversationId: conversation.id, requestId, secret: SECRET, vaulted: true }))
      .toEqual({ status: "rejected", reason: "not-pending" });
    expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("declined");
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
      status: "ended", reason: "cancelled", message: SECRET_REQUEST_ENDED_MESSAGE,
    });
    expect(harness.store.transcriptRepository.secretRequests.find(abortedId)?.status).toBe("ended");
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
    expect(harness.store.transcriptRepository.secretRequests.find(firstId)?.status).toBe("expired");
    expect(harness.forgotten).toContain(agentSecretReference(firstId));
    expect(harness.service.output.values()).not.toContain(SECRET);
    expect(existsSync(secondFile)).toBe(true);

    expect(await harness.service.revoke(secondId)).toBe("revoked");
    expect(await harness.service.revoke(secondId)).toBe("not-active");
    expect(existsSync(dirname(secondFile))).toBe(false);
    expect(harness.store.transcriptRepository.secretRequests.find(secondId)?.status).toBe("revoked");
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
    expect(harness.store.transcriptRepository.secretRequests.find(waitingId)?.status).toBe("ended");
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
    expect(store.transcriptRepository.secretRequests.find(pendingRequest)?.status).toBe("ended");
    store.transcriptRepository.secretRequests.create({
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
    const requests = third.store.transcriptRepository.secretRequests;
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

describe("agent secret service: conversation delete", () => {
  it("revokes the deleted conversation's secrets at once and leaves other chats alone", async () => {
    const harness = await openHarness();
    const doomed = chat(harness.store, "Doomed");
    const doomedResult = harness.service.invoke(doomed, call(VALID));
    const doomedId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: doomed.conversation.id, requestId: doomedId, secret: SECRET, vaulted: true });
    const doomedFile = parsed(await doomedResult).file as string;
    const kept = chat(harness.store, "Kept");
    const keptResult = harness.service.invoke(kept, call(VALID));
    const keptId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: kept.conversation.id, requestId: keptId, secret: "ghp_keptValue12345678", vaulted: true });
    const keptFile = parsed(await keptResult).file as string;
    const handler = createConversationCommandHandler({
      store: harness.store,
      conversationAttachments: { release: vi.fn(async () => undefined) } as never,
      providers: {} as never,
      backendProfileController: {} as never,
      workspaceRuns: {} as never,
      providerTerminalResumes: new ProviderTerminalResumeRegistry(harness.store.conversationWork),
      runtimeSync: {} as never,
      deletedConversationIds: new Set(),
      dataDirectory: harness.directory,
      rememberDeletedConversation: vi.fn(),
      forgetRemoteTranscript: vi.fn(),
      broadcastSnapshot: vi.fn(),
      publicError: (error) => String(error),
      send: vi.fn(),
      agentSecrets: harness.service,
    });
    const events = harness.events.length;

    await expect(handler({} as never, {
      type: "conversation.delete",
      requestId: randomUUID(),
      payload: { conversationId: doomed.conversation.id },
    })).resolves.toBe("mutation");

    expect(existsSync(dirname(doomedFile))).toBe(false);
    expect(harness.forgotten).toEqual([agentSecretReference(doomedId)]);
    expect(harness.store.transcriptRepository.secretRequests.find(doomedId)).toBeNull();
    expect(harness.service.output.values()).not.toContain(SECRET);
    expect(harness.service.output.values()).toContain("ghp_keptValue12345678");
    expect(harness.service.filePath(doomedId)).toBeNull();
    expect(harness.events.slice(events)).toEqual([]);
    expect(readFileSync(keptFile, "utf8")).toBe("ghp_keptValue12345678");
    expect(harness.store.transcriptRepository.secretRequests.find(keptId)?.status).toBe("saved");
    expect(harness.service.list().map(({ requestId }) => requestId)).toEqual([keptId]);
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
    expect(harness.store.transcriptRepository.secretRequests.forConversation(source.conversation.id)).toHaveLength(1);
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
    expect(harness.store.transcriptRepository.secretRequests.pendingAll()).toEqual([]);
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
    expect(harness.store.transcriptRepository.secretRequests.forConversation(source.conversation.id)).toEqual([]);
    expect(harness.waits).toEqual([]);
  });

  it("ends immediately when the turn is not active in the controller", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const refusing = new AgentSecretService({
      store: harness.store,
      dataDirectory: harness.directory,
      turns: { open: () => null, wait: () => false },
      broadcast: () => undefined,
      waitMs: () => 60_000,
    });
    services.push(refusing);
    const result = await refusing.invoke(source, call(VALID));
    expect(parsed(result)).toMatchObject({ status: "ended", reason: "cancelled" });
    expect(harness.store.transcriptRepository.secretRequests.forConversation(source.conversation.id)[0]?.status).toBe("ended");
  });
});

describe("agent secret service: lifecycle hardening", () => {
  async function saved(harness: Harness, title = "Saved", secret = SECRET, vaulted = true) {
    const source = chat(harness.store, title);
    const result = harness.service.invoke(source, call({ ...VALID, title, ttlHours: 1 }));
    const requestId = pendingId(harness.store);
    await harness.service.deliver({ conversationId: source.conversation.id, requestId, secret, vaulted });
    return { source, requestId, file: parsed(await result).file as string };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  it("keeps the runtime alive when the secret table cannot be read at start or during a sweep", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-secret-start-"));
    directories.push(directory);
    const broken = {
      get transcriptRepository(): never {
        throw new Error("database is locked");
      },
      conversation: () => {
        throw new Error("database is locked");
      },
    } as never;
    const service = new AgentSecretService({
      store: broken,
      dataDirectory: directory,
      turns: { open: () => null, wait: () => false },
      broadcast: () => undefined,
    });
    services.push(service);
    expect(() => service.start()).not.toThrow();
    expect(() => service.sweep()).not.toThrow();
    await expect(service.restore()).resolves.toBeUndefined();
  });

  it("forgets the keychain copy of a request left pending by a crash when it ends it at start", async () => {
    const first = await openHarness();
    const source = chat(first.store);
    void first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    services.splice(services.indexOf(first.service), 1);
    const second = await openHarness({ directory: first.directory });
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("ended");
    expect(second.forgotten).toContain(agentSecretReference(requestId));
    first.service.shutdown();
  });

  it("registers a restored value for redaction before its file exists again", async () => {
    const first = await openHarness();
    const { requestId, file } = await saved(first);
    first.service.shutdown();
    let release!: (value: string) => void;
    const second = await openHarness({
      directory: first.directory,
      resolve: () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    });
    const restoring = second.service.restore();
    await vi.waitFor(() => expect(second.resolveVault).toHaveBeenCalledWith(agentSecretReference(requestId)));
    release(SECRET);
    await flushMicrotasks();
    expect(existsSync(file)).toBe(false);
    expect(second.service.output.text(`key ${SECRET}`)).toBe("key [redacted]");
    await restoring;
    expect(readFileSync(file, "utf8")).toBe(SECRET);
  });

  it("does not resurrect a secret revoked while its file was being restored", async () => {
    const first = await openHarness();
    const { requestId, file } = await saved(first);
    first.service.shutdown();
    let release!: (value: string) => void;
    const second = await openHarness({
      directory: first.directory,
      resolve: () => new Promise<string>((resolve) => {
        release = resolve;
      }),
    });
    const restoring = second.service.restore();
    await vi.waitFor(() => expect(second.resolveVault).toHaveBeenCalled());
    release(SECRET);
    await flushMicrotasks();
    expect(await second.service.revoke(requestId)).toBe("revoked");
    await restoring;
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dirname(file))).toBe(false);
    expect(second.service.output.values()).toEqual([]);
    expect(second.service.filePath(requestId)).toBeNull();
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("revoked");
  });

  it("refuses to call a locked file revoked, and revokes once the file can be deleted", async () => {
    const harness = await openHarness();
    const { requestId, file } = await saved(harness);
    const token = basenameOf(dirname(file));
    harness.locked.add(token);
    expect(await harness.service.revoke(requestId)).toBe("in-use");
    expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("saved");
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(harness.service.output.text(SECRET)).toBe("[redacted]");
    expect(harness.service.list().map(({ requestId: id }) => id)).toEqual([requestId]);
    expect(harness.forgotten).not.toContain(agentSecretReference(requestId));
    harness.locked.delete(token);
    expect(await harness.service.revoke(requestId)).toBe("revoked");
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("keeps redacting an expired value whose file is locked and retries the delete on every sweep", async () => {
    const harness = await openHarness();
    const { requestId, file } = await saved(harness);
    const token = basenameOf(dirname(file));
    harness.locked.add(token);
    harness.clock.now += 60 * 60_000;
    harness.service.sweep();
    expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
    expect(existsSync(file)).toBe(true);
    expect(harness.service.output.text(`cat → ${SECRET}`)).toBe("cat → [redacted]");
    harness.service.sweep();
    expect(existsSync(file)).toBe(true);
    harness.locked.delete(token);
    harness.service.sweep();
    expect(existsSync(dirname(file))).toBe(false);
    expect(harness.service.output.values()).toEqual([]);
  });

  it("expires within one five-minute sweep when the expiry timer was held back by a system suspend", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const harness = await openHarness();
      const { requestId, file } = await saved(harness);
      harness.clock.now += 2 * 60 * 60_000;
      vi.advanceTimersByTime(4 * 60_000);
      expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("saved");
      vi.advanceTimersByTime(60_000);
      expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
      expect(existsSync(dirname(file))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps redacting a value whose private file stays locked across a restart, without restoring it, until a sweep deletes it", async () => {
    const first = await openHarness();
    const { requestId, file } = await saved(first);
    const token = basenameOf(dirname(file));
    services.splice(services.indexOf(first.service), 1);
    const second = await openHarness({
      directory: first.directory,
      vault: { [agentSecretReference(requestId)]: SECRET },
      start: false,
      platform: process.platform,
    });
    second.clock.now = first.clock.now + 2 * 60 * 60_000;
    second.locked.add(token);
    expect(() => second.service.start()).not.toThrow();
    await second.service.restore();
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
    expect(second.resolveVault).not.toHaveBeenCalled();
    expect(second.forgotten).toContain(agentSecretReference(requestId));
    expect(second.service.filePath(requestId)).toBeNull();
    expect(second.service.list()).toEqual([]);
    expect(second.service.output.text(`late cat → ${SECRET}`)).toBe("late cat → [redacted]");
    second.service.sweep();
    expect(second.service.output.text(SECRET)).toBe("[redacted]");
    second.locked.delete(token);
    second.service.sweep();
    expect(existsSync(dirname(file))).toBe(false);
    expect(second.service.output.values()).toEqual([]);
    first.service.shutdown();
  });

  it.skipIf(!POSIX)("never reads a retained value through a symlink, a shared file or a hard link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-secret-retained-"));
    directories.push(directory);
    const root = agentSecretRoot(directory);
    const outside = join(directory, "outside");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await writeFile(join(outside, "secret"), "outside-value-1234", { mode: 0o600 });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const tokens = { linkedDir: "a".repeat(32), shared: "b".repeat(32), linkedFile: "c".repeat(32), hardLink: "d".repeat(32), kept: "e".repeat(32) };
    symlinkSync(outside, join(root, tokens.linkedDir));
    for (const token of [tokens.shared, tokens.linkedFile, tokens.hardLink, tokens.kept]) await mkdir(join(root, token), { mode: 0o700 });
    await writeFile(join(root, tokens.shared, "secret"), "shared-value-1234", { mode: 0o644 });
    symlinkSync(join(outside, "secret"), join(root, tokens.linkedFile, "secret"));
    linkSync(join(outside, "secret"), join(root, tokens.hardLink, "secret"));
    await writeFile(join(root, tokens.kept, "secret"), "retained-value-1234", { mode: 0o600 });
    const harness = await openHarness({ directory, start: false });
    for (const token of Object.values(tokens)) harness.locked.add(token);
    harness.service.start();
    expect(harness.service.output.values()).toEqual(expect.arrayContaining(["retained-value-1234"]));
    for (const value of ["outside-value-1234", "shared-value-1234"]) {
      expect(harness.service.output.text(value)).toBe(value);
    }
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside-value-1234");
    harness.locked.clear();
    harness.service.sweep();
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("outside-value-1234");
    expect(harness.service.output.values()).toEqual([]);
  });

  it("rejects a value that fails validation in the runtime and keeps the request pending", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const result = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    for (const secret of [" padded ", "ab", "two\nlines"]) {
      expect(await harness.service.deliver({ conversationId: source.conversation.id, requestId, secret, vaulted: true }))
        .toEqual({ status: "rejected", reason: "invalid" });
    }
    expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("pending");
    expect(await harness.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true }))
      .toMatchObject({ status: "delivered" });
    expect(parsed(await result)).toMatchObject({ status: "saved" });
  });

  it("stamps the card after the assistant text that the turn flushed for it", async () => {
    const harness = await openHarness();
    const source = chat(harness.store);
    const later = new Date(harness.clock.now + 5_000).toISOString();
    const service = new AgentSecretService({
      store: harness.store,
      dataDirectory: harness.directory,
      turns: { open: () => ({ notBefore: later }), wait: () => true },
      broadcast: () => undefined,
      clock: () => harness.clock.now,
      waitMs: () => 60_000,
    });
    services.push(service);
    void service.invoke(source, call(VALID));
    const request = harness.store.transcriptRepository.secretRequests.find(pendingId(harness.store))!;
    expect(request.createdAt).toBe(new Date(Date.parse(later) + 1).toISOString());
    expect(harness.store.message(request.messageId).createdAt).toBe(request.createdAt);
  });
});

function basenameOf(path: string): string {
  return path.split(/[\\/]/u).at(-1)!;
}

describe("agent secret service: in-flight saves and keychain reconciliation", () => {
  function gatedWriter(onWrite: (token: string) => void = () => undefined) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    const tokens: string[] = [];
    const writeFile: typeof writeAgentSecretFile = async (root, token, fileName, value) => {
      tokens.push(token);
      onWrite(token);
      const file = await writeAgentSecretFile(root, token, fileName, value);
      markWritten();
      await gate;
      return file;
    };
    return { writeFile, release: () => release(), tokens, written };
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it("redacts a new value before its file can be read and keeps the directory being written through a sweep", async () => {
    let harness!: Harness;
    let redactedBeforeWrite = false;
    const writer = gatedWriter(() => {
      redactedBeforeWrite = harness.service.output.text(`cat → ${SECRET}`) === "cat → [redacted]";
    });
    harness = await openHarness({ writeFile: writer.writeFile });
    const source = chat(harness.store);
    const result = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    const delivery = harness.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    await writer.written;
    expect(redactedBeforeWrite).toBe(true);
    const directory = join(agentSecretRoot(harness.directory), writer.tokens[0]!);
    expect(existsSync(directory)).toBe(true);
    harness.service.sweep();
    expect(existsSync(directory)).toBe(true);
    expect(harness.service.output.text(SECRET)).toBe("[redacted]");
    writer.release();
    await expect(delivery).resolves.toMatchObject({ status: "delivered" });
    const file = parsed(await result).file as string;
    expect(dirname(file)).toBe(directory);
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    harness.service.sweep();
    expect(readFileSync(file, "utf8")).toBe(SECRET);
  });

  it("keeps redacting a value whose failed write left a locked directory, until a sweep deletes it", async () => {
    let harness!: Harness;
    const writeFile: typeof writeAgentSecretFile = async (root, token, fileName, value) => {
      await writeAgentSecretFile(root, token, fileName, value);
      harness.locked.add(token);
      throw new Error("ENOSPC: no space left on device");
    };
    harness = await openHarness({ writeFile });
    const source = chat(harness.store);
    void harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    await expect(harness.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true }))
      .resolves.toEqual({ status: "rejected", reason: "file-failed" });
    expect(harness.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("pending");
    expect(harness.service.output.text(SECRET)).toBe("[redacted]");
    harness.service.sweep();
    expect(harness.service.output.text(SECRET)).toBe("[redacted]");
    harness.locked.clear();
    harness.service.sweep();
    expect(harness.service.output.values()).toEqual([]);
    expect(readdirSync(agentSecretRoot(harness.directory))).toEqual([]);
  });

  it("drops redaction for a failed write once its directory is gone", async () => {
    const writeFile: typeof writeAgentSecretFile = async () => {
      throw new Error("EACCES: permission denied");
    };
    const harness = await openHarness({ writeFile });
    const source = chat(harness.store);
    void harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    await expect(harness.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: false }))
      .resolves.toEqual({ status: "rejected", reason: "file-failed" });
    expect(harness.service.output.values()).toEqual([]);
  });

  it("reports only requests that can no longer use their keychain copy as orphaned", async () => {
    const harness = await openHarness();
    const savedChat = chat(harness.store, "Saved");
    const savedResult = harness.service.invoke(savedChat, call(VALID));
    const saved = pendingId(harness.store);
    await harness.service.deliver({ conversationId: savedChat.conversation.id, requestId: saved, secret: SECRET, vaulted: true });
    await savedResult;
    const declinedChat = chat(harness.store, "Declined");
    const declinedResult = harness.service.invoke(declinedChat, call(VALID));
    const declined = pendingId(harness.store);
    await harness.service.decline(declinedChat.conversation.id, declined);
    await declinedResult;
    const pendingChat = chat(harness.store, "Pending");
    void harness.service.invoke(pendingChat, call(VALID));
    const pending = pendingId(harness.store);
    const unknown = randomUUID();
    expect(harness.service.orphanedVaultRequests([saved, declined, pending, unknown])).toEqual([declined, unknown]);
    vi.spyOn(harness.store.transcriptRepository.secretRequests, "find").mockImplementation(() => {
      throw new Error("database is locked");
    });
    expect(harness.service.orphanedVaultRequests([declined, unknown])).toEqual([]);
  });

  it("forgets the copy of a save still in flight at shutdown, and the next start reports it orphaned", async () => {
    const writer = gatedWriter();
    const first = await openHarness({ writeFile: writer.writeFile });
    const source = chat(first.store);
    const result = first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    const delivery = first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    await writer.written;
    first.service.shutdown();
    expect(first.forgotten).toEqual([agentSecretReference(requestId)]);
    expect(first.service.orphanedVaultRequests([requestId])).toEqual([]);
    writer.release();
    await expect(delivery).resolves.toEqual({ status: "rejected", reason: "ended" });
    expect(parsed(await result)).toMatchObject({ status: "ended" });
    expect(readdirSync(agentSecretRoot(first.directory))).toEqual([]);
    expect(first.service.output.values()).toEqual([]);
    services.splice(services.indexOf(first.service), 1);
    const second = await openHarness({ directory: first.directory });
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("ended");
    expect(second.service.orphanedVaultRequests([requestId])).toEqual([requestId]);
  });

  it("retries a rejected or timed-out keychain forget on the next sweep until it succeeds", async () => {
    let failures = 2;
    const harness = await openHarness({
      forget: async () => {
        if (failures-- > 0) throw new Error("Secure credential storage did not respond in time.");
        return true;
      },
    });
    const source = chat(harness.store);
    const result = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    await harness.service.decline(source.conversation.id, requestId);
    await result;
    const reference = agentSecretReference(requestId);
    await settle();
    expect(harness.forgotten).toEqual([reference]);
    harness.service.sweep();
    await settle();
    expect(harness.forgotten).toEqual([reference, reference]);
    harness.service.sweep();
    await settle();
    expect(harness.forgotten).toEqual([reference, reference, reference]);
    harness.service.sweep();
    await settle();
    expect(harness.forgotten).toEqual([reference, reference, reference]);
  });

  it("cancels pending requests for a specific turn via cancelForTurn without disturbing other turns", async () => {
    const harness = await openHarness();
    const first = chat(harness.store, "First");
    const second = chat(harness.store, "Second");
    const firstResult = harness.service.invoke(first, call(VALID));
    const firstId = pendingId(harness.store);
    const secondResult = harness.service.invoke(second, call(VALID));
    const secondId = harness.store.transcriptRepository.secretRequests.pendingAll()
      .find(({ id }) => id !== firstId)!.id;

    expect(harness.service.pendingCount()).toBe(2);
    expect(harness.service.hasPending(first.conversation.id)).toBe(true);
    expect(harness.service.pendingConversationIds()).toEqual(new Set([first.conversation.id, second.conversation.id]));

    harness.service.cancelForTurn(first.conversation.id, first.turn.id);
    expect(parsed(await firstResult)).toMatchObject({ status: "ended", reason: "stopped" });
    expect(harness.store.transcriptRepository.secretRequests.find(firstId)?.status).toBe("ended");
    expect(harness.service.pendingCount()).toBe(1);
    expect(harness.service.hasPending(first.conversation.id)).toBe(false);
    expect(harness.service.hasPending(second.conversation.id)).toBe(true);

    harness.service.cancelForTurn(second.conversation.id, second.turn.id, "cancelled");
    expect(parsed(await secondResult)).toMatchObject({ status: "ended", reason: "cancelled" });
    expect(harness.store.transcriptRepository.secretRequests.find(secondId)?.status).toBe("ended");
    expect(harness.service.pendingCount()).toBe(0);
    expect(harness.service.pendingConversationIds().size).toBe(0);
  });

  it("revokeForConversation ends pending requests, drains queued restoring records, and forgets vault copies without broadcasting", async () => {
    const first = await openHarness();
    const restoredChat = chat(first.store, "Restoring");
    const restoredInvoke = first.service.invoke(restoredChat, call(VALID));
    const restoredId = pendingId(first.store);
    await first.service.deliver({
      conversationId: restoredChat.conversation.id,
      requestId: restoredId,
      secret: SECRET,
      vaulted: true,
    });
    await restoredInvoke;
    first.service.shutdown();
    services.splice(services.indexOf(first.service), 1);

    const second = await openHarness({
      directory: first.directory,
      vault: { [agentSecretReference(restoredId)]: SECRET },
    });
    const pendingInvoke = second.service.invoke(restoredChat, call(VALID));
    const pendingReqId = pendingId(second.store);
    const eventsBefore = second.events.length;

    second.service.revokeForConversation(restoredChat.conversation.id);

    expect(parsed(await pendingInvoke)).toMatchObject({ status: "ended", reason: "cancelled" });
    expect(second.store.transcriptRepository.secretRequests.find(pendingReqId)?.status).toBe("ended");
    expect(second.store.transcriptRepository.secretRequests.find(restoredId)?.status).toBe("revoked");
    expect(second.forgotten).toEqual(expect.arrayContaining([
      agentSecretReference(pendingReqId),
      agentSecretReference(restoredId),
    ]));
    expect(second.events.slice(eventsBefore)).toEqual([]);
    await second.service.restore();
    expect(second.resolveVault).not.toHaveBeenCalled();
  });

  it("treats saved unvaulted secrets as orphaned in orphanedVaultRequests even while active", async () => {
    const harness = await openHarness();
    const memoryChat = chat(harness.store, "MemoryOnly");
    const memoryResult = harness.service.invoke(memoryChat, call(VALID));
    const memoryId = pendingId(harness.store);
    await harness.service.deliver({
      conversationId: memoryChat.conversation.id,
      requestId: memoryId,
      secret: SECRET,
      vaulted: false,
    });
    await memoryResult;
    const vaultedChat = chat(harness.store, "Vaulted");
    const vaultedResult = harness.service.invoke(vaultedChat, call(VALID));
    const vaultedId = pendingId(harness.store);
    await harness.service.deliver({
      conversationId: vaultedChat.conversation.id,
      requestId: vaultedId,
      secret: "ghp_vaultedValue12345",
      vaulted: true,
    });
    await vaultedResult;

    expect(harness.service.orphanedVaultRequests([memoryId, vaultedId])).toEqual([memoryId]);
  });

  it("handles transient keychain errors during restore without retiring or forgetting, preserves retained files, and retries on sweep", async () => {
    const first = await openHarness();
    const source = chat(first.store, "Transient");
    const invoke = first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    // Simulate a crash: do NOT call first.service.shutdown(), leaving the file on disk.
    services.splice(services.indexOf(first.service), 1);

    let failCount = 1;
    let restoredWrites = 0;
    const second = await openHarness({
      directory: first.directory,
      start: false,
      platform: process.platform,
      writeFile: async (root, token, fileName, value, options) => {
        const target = await writeAgentSecretFile(root, token, fileName, value, options);
        restoredWrites += 1;
        return target;
      },
      resolve: async (reference) => {
        if (reference === agentSecretReference(requestId) && failCount-- > 0) {
          throw new Error("Keychain temporarily locked");
        }
        return reference === agentSecretReference(requestId) ? SECRET : null;
      },
    });
    second.service.start();
    // Retained directory for restoring token is preserved and redacted before restore finishes.
    expect(existsSync(file)).toBe(true);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    await second.service.restore();
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("saved");
    expect(second.forgotten).not.toContain(agentSecretReference(requestId));
    expect(existsSync(file)).toBe(true);

    // Retry triggered by sweep succeeds.
    second.service.sweep();
    await vi.waitFor(() => {
      expect(restoredWrites).toBe(1);
      expect(second.service.filePath(requestId)).toBe(file);
    });
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");
    first.service.shutdown();
  });

  it("defers win32 DACL hardening for empty roots on startup, hardens before retaining surviving crash files, and removes them if hardening fails", async () => {
    const emptyCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const emptyExec = vi.fn<AgentSecretExecFileSync>(() => "");
    await openHarness({
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: emptyExec,
        windowsDaclCache: emptyCache,
      }),
    });
    expect(emptyExec).not.toHaveBeenCalled();

    // Crash with an unexpired vaulted secret file still on disk.
    const first = await openHarness();
    const source = chat(first.store, "WinCrash");
    const invoke = first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    services.splice(services.indexOf(first.service), 1);

    // Restart with a fresh process cache and locked keychain: startup must harden before retaining the file.
    const restartCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const restartExec = vi.fn<AgentSecretExecFileSync>(() => "");
    const second = await openHarness({
      directory: first.directory,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: restartExec,
        windowsDaclCache: restartCache,
      }),
      resolve: async () => {
        throw new Error("Keychain temporarily locked");
      },
    });
    expect(restartExec).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(true);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    // If hardening fails on restart, do not retain plaintext under a potentially permissive ACL.
    const failCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const failExec = vi.fn<AgentSecretExecFileSync>(() => {
      throw new Error("SetAccessControl failed");
    });
    const third = await openHarness({
      directory: first.directory,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: failExec,
        windowsDaclCache: failCache,
      }),
      resolve: async () => {
        throw new Error("Keychain temporarily locked");
      },
    });
    expect(failExec).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
    expect(third.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("saved");
    first.service.shutdown();
  });

  it("attempts startup DACL hardening at most once across multiple crash files and retries hardening or deletion on sweep independently of vault restore", async () => {
    const first = await openHarness();
    const firstChat = chat(first.store, "CrashOne");
    const firstInvoke = first.service.invoke(firstChat, call({ ...VALID, fileName: "token-one" }));
    const firstId = pendingId(first.store);
    await first.service.deliver({
      conversationId: firstChat.conversation.id,
      requestId: firstId,
      secret: "ghp_crashSecretOne111",
      vaulted: true,
    });
    const firstFile = parsed(await firstInvoke).file as string;
    const firstToken = first.store.transcriptRepository.secretRequests.find(firstId)!.fileToken!;

    const secondChat = chat(first.store, "CrashTwo");
    const secondInvoke = first.service.invoke(secondChat, call({ ...VALID, fileName: "token-two" }));
    const secondId = pendingId(first.store);
    await first.service.deliver({
      conversationId: secondChat.conversation.id,
      requestId: secondId,
      secret: "ghp_crashSecretTwo222",
      vaulted: true,
    });
    const secondFile = parsed(await secondInvoke).file as string;
    services.splice(services.indexOf(first.service), 1);

    // Restart with both files surviving, DACL hardening failing, and firstToken temporarily locked.
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    let shouldFailHardening = true;
    const execFile = vi.fn<AgentSecretExecFileSync>(() => {
      if (shouldFailHardening) throw new Error("SetAccessControl timed out");
      return "";
    });
    const stalledHardening: { release?: () => void } = {};
    const execFileAsync = vi.fn<AgentSecretExecFileAsync>(() => new Promise<string>((resolvePromise, rejectPromise) => {
      stalledHardening.release = () => {
        if (shouldFailHardening) rejectPromise(new Error("SetAccessControl timed out"));
        else resolvePromise("");
      };
    }));
    const recovered = await openHarness({
      directory: first.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile,
        windowsDaclCache: cache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync,
        windowsDaclCache: cache,
      }),
      resolve: async () => {
        throw new Error("Keychain still locked");
      },
    });
    recovered.locked.add(firstToken);
    recovered.service.start();

    // S13: hardening was attempted only ONCE across both retained tokens.
    expect(execFile).toHaveBeenCalledTimes(1);
    // Unlocked secondFile was removed immediately; locked firstFile stays redacted while locked.
    expect(existsSync(secondFile)).toBe(false);
    expect(existsSync(firstFile)).toBe(true);
    expect(recovered.service.output.text("leaked ghp_crashSecretOne111")).toBe("leaked [redacted]");

    // S14: sweep retries hardening asynchronously (never calling sync execFile) and keeps only
    // one async hardening attempt in flight across repeated sweeps while the file stays locked.
    recovered.service.sweep();
    recovered.service.sweep();
    await vi.waitFor(() => expect(execFileAsync).toHaveBeenCalledTimes(1));
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(existsSync(firstFile)).toBe(true);

    // S12 + S14: even while the async hardening attempt is still stalled in flight, clearing the
    // file lock lets the next sweep delete the unhardened file asynchronously without blocking.
    recovered.locked.delete(firstToken);
    recovered.service.sweep();
    await vi.waitFor(() => expect(existsSync(firstFile)).toBe(false));
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(recovered.service.output.text("leaked ghp_crashSecretOne111")).toBe("leaked ghp_crashSecretOne111");
    stalledHardening.release?.();
    await Promise.resolve();

    // Also verify recovery when async hardening succeeds on sweep while the file remains locked.
    const third = await openHarness();
    const thirdChat = chat(third.store, "CrashThree");
    const thirdInvoke = third.service.invoke(thirdChat, call({ ...VALID, fileName: "token-three" }));
    const thirdId = pendingId(third.store);
    await third.service.deliver({
      conversationId: thirdChat.conversation.id,
      requestId: thirdId,
      secret: "ghp_crashSecretThree333",
      vaulted: true,
    });
    const thirdFile = parsed(await thirdInvoke).file as string;
    const thirdToken = third.store.transcriptRepository.secretRequests.find(thirdId)!.fileToken!;
    services.splice(services.indexOf(third.service), 1);

    const recoverCache: WindowsDaclCache = { hardenedRoots: new Map() };
    shouldFailHardening = true;
    const recoverExec = vi.fn<AgentSecretExecFileSync>(() => {
      if (shouldFailHardening) throw new Error("SetAccessControl failed");
      return "";
    });
    const recoverExecAsync = vi.fn<AgentSecretExecFileAsync>(async () => {
      if (shouldFailHardening) throw new Error("SetAccessControl failed");
      return "";
    });
    const fourth = await openHarness({
      directory: third.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: recoverExec,
        windowsDaclCache: recoverCache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: recoverExecAsync,
        windowsDaclCache: recoverCache,
      }),
      resolve: async () => {
        throw new Error("Keychain still locked");
      },
    });
    fourth.locked.add(thirdToken);
    fourth.service.start();
    expect(recoverExec).toHaveBeenCalledTimes(1);
    expect(existsSync(thirdFile)).toBe(true);

    // Async hardening recovers on the next sweep: root is hardened and subsequent sweeps do not re-run it.
    shouldFailHardening = false;
    fourth.service.sweep();
    await vi.waitFor(() => expect(recoverExecAsync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(recoverCache.hardenedRoots.size).toBe(1));
    expect(existsSync(thirdFile)).toBe(true);
    fourth.service.sweep();
    await Promise.resolve();
    expect(recoverExec).toHaveBeenCalledTimes(1);
    expect(recoverExecAsync).toHaveBeenCalledTimes(1);
    first.service.shutdown();
    third.service.shutdown();
  });

  it("preserves DACL retry across a failed restore with a concurrent sweep (S15) and performs one async deletion per unhardened stray token per sweep (S16)", async () => {
    // S15: concurrent sweep while restore's writeFile is awaiting must NOT drop the unhardened marker.
    const first = await openHarness();
    const source = chat(first.store, "RestoreRace");
    const invoke = first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    const token = first.store.transcriptRepository.secretRequests.find(requestId)!.fileToken!;
    services.splice(services.indexOf(first.service), 1);

    const writeGate: { reject?: (error: Error) => void; started?: () => void } = {};
    const writeStarted = new Promise<void>((resolvePromise) => {
      writeGate.started = resolvePromise;
    });
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    let failHardening = true;
    const syncHardening = vi.fn<AgentSecretExecFileSync>(() => {
      if (failHardening) throw new Error("SetAccessControl failed");
      return "";
    });
    const asyncHardening = vi.fn<AgentSecretExecFileAsync>(async () => {
      if (failHardening) throw new Error("SetAccessControl failed");
      return "";
    });
    const second = await openHarness({
      directory: first.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: syncHardening,
        windowsDaclCache: cache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: asyncHardening,
        windowsDaclCache: cache,
      }),
      resolve: async (reference) => (reference === agentSecretReference(requestId) ? SECRET : null),
      writeFile: () => new Promise<string>((_resolve, reject) => {
        writeGate.reject = reject;
        writeGate.started?.();
      }),
    });
    second.locked.add(token);
    second.service.start();
    expect(syncHardening).toHaveBeenCalledTimes(1);

    const restorePromise = second.service.restore();
    await writeStarted;
    // Concurrent sweep while restore has marked the token active before writeFile finishes.
    second.service.sweep();
    await Promise.resolve();
    // Now restore's write fails (e.g. DACL hardening failure) while the file remains locked.
    writeGate.reject?.(new Error("Could not harden Windows permissions"));
    await restorePromise;
    expect(existsSync(file)).toBe(true);

    // Next sweep must still retry DACL hardening because the unhardened marker was preserved!
    failHardening = false;
    second.service.sweep();
    await vi.waitFor(() => expect(asyncHardening).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(cache.hardenedRoots.size).toBe(1));
    first.service.shutdown();

    // S16: locked unhardened stray token outside restore uses strictly one async deletion per sweep (zero sync calls).
    const strayBase = await openHarness({ start: false });
    const strayToken = "abcdef0123456789abcdef0123456789";
    await writeAgentSecretFile(agentSecretRoot(strayBase.directory), strayToken, "stray-key", SECRET);
    let syncRemoveCalls = 0;
    let asyncRemoveCalls = 0;
    let lockStray = true;
    const strayCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const strayExecSync = vi.fn<AgentSecretExecFileSync>(() => {
      throw new Error("SetAccessControl failed");
    });
    const strayExecAsync = vi.fn<AgentSecretExecFileAsync>(async () => {
      throw new Error("SetAccessControl failed");
    });
    const strayHarness = await openHarness({
      directory: strayBase.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: strayExecSync,
        windowsDaclCache: strayCache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: strayExecAsync,
        windowsDaclCache: strayCache,
      }),
      removeDirectory: (root, targetToken) => {
        syncRemoveCalls += 1;
        if (lockStray) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        removeAgentSecretDirectory(root, targetToken);
      },
      removeDirectoryAsync: async (root, targetToken) => {
        asyncRemoveCalls += 1;
        if (lockStray) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        removeAgentSecretDirectory(root, targetToken);
      },
    });
    strayHarness.service.start();
    // Startup tried sync deletion once and hardening once.
    expect(syncRemoveCalls).toBe(1);
    expect(strayExecSync).toHaveBeenCalledTimes(1);

    // Sweep must NOT call sync removeDirectory at all — only ONE async deletion attempt per sweep.
    strayHarness.service.sweep();
    await vi.waitFor(() => expect(strayExecAsync).toHaveBeenCalledTimes(1));
    expect(syncRemoveCalls).toBe(1);
    expect(asyncRemoveCalls).toBe(1);

    // Once unlocked, next sweep removes it via one async call with zero sync calls.
    lockStray = false;
    strayHarness.service.sweep();
    await vi.waitFor(() => expect(asyncRemoveCalls).toBe(2));
    expect(syncRemoveCalls).toBe(1);
    expect(readdirSync(agentSecretRoot(strayBase.directory))).toEqual([]);
  });

  it("serializes in-flight async removal with restore writes for the same token (S17) and routes expired unhardened cleanup strictly through async reconciliation (S18)", async () => {
    // S17: sweep starts async removal and then restore runs for the same token;
    // restore must wait for the in-flight removal to finish before writing the replacement file.
    const first = await openHarness();
    const firstChat = chat(first.store, "SerializeRestore");
    const firstInvoke = first.service.invoke(firstChat, call(VALID));
    const firstId = pendingId(first.store);
    await first.service.deliver({ conversationId: firstChat.conversation.id, requestId: firstId, secret: SECRET, vaulted: true });
    const firstFile = parsed(await firstInvoke).file as string;
    const firstToken = first.store.transcriptRepository.secretRequests.find(firstId)!.fileToken!;
    services.splice(services.indexOf(first.service), 1);

    const eventsOrder: string[] = [];
    const deleteGate: { release?: () => void; started?: () => void } = {};
    const deleteStarted = new Promise<void>((resolvePromise) => {
      deleteGate.started = resolvePromise;
    });
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    let failHardening = true;
    const second = await openHarness({
      directory: first.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: () => {
          if (failHardening) throw new Error("SetAccessControl failed");
          return "";
        },
        windowsDaclCache: cache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: async () => "",
        windowsDaclCache: cache,
      }),
      removeDirectoryAsync: async (root, targetToken) => {
        eventsOrder.push("delete-start");
        deleteGate.started?.();
        await new Promise<void>((resolvePromise) => {
          deleteGate.release = resolvePromise;
        });
        removeAgentSecretDirectory(root, targetToken);
        eventsOrder.push("delete-end");
      },
      writeFile: async (root, targetToken, fileName, value) => {
        eventsOrder.push("write-start");
        const written = await writeAgentSecretFile(root, targetToken, fileName, value, {
          platform: "win32",
          env: WIN32_TEST_ENV,
          execFileAsync: async () => "",
          windowsDaclCache: cache,
        });
        eventsOrder.push("write-end");
        return written;
      },
      resolve: async (reference) => (reference === agentSecretReference(firstId) ? SECRET : null),
    });
    second.locked.add(firstToken);
    second.service.start();
    // Sweep starts async deletion AND kicks off restore for the same token.
    failHardening = false;
    second.service.sweep();
    await deleteStarted;
    // Allow vault resolve microtasks to run: writeFile MUST NOT start while async deletion is in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(eventsOrder).toEqual(["delete-start"]);

    deleteGate.release?.();
    await vi.waitFor(() => expect(eventsOrder).toEqual(["delete-start", "delete-end", "write-start", "write-end"]));
    expect(readFileSync(firstFile, "utf8")).toBe(SECRET);
    expect(second.service.filePath(firstId)).toBe(firstFile);
    first.service.shutdown();

    // S18: expiring a saved unhardened token on sweep performs zero sync removal and strictly one async removal.
    const third = await openHarness();
    const thirdChat = chat(third.store, "ExpireUnhardened");
    const thirdInvoke = third.service.invoke(thirdChat, call({ ...VALID, ttlHours: 1 }));
    const thirdId = pendingId(third.store);
    await third.service.deliver({ conversationId: thirdChat.conversation.id, requestId: thirdId, secret: SECRET, vaulted: true });
    const thirdFile = parsed(await thirdInvoke).file as string;
    services.splice(services.indexOf(third.service), 1);

    let syncRemoves = 0;
    let asyncRemoves = 0;
    let keepLocked = true;
    const expireCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const expireAsyncHardening = vi.fn<AgentSecretExecFileAsync>(async () => {
      throw new Error("SetAccessControl failed");
    });
    const fourth = await openHarness({
      directory: third.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: () => {
          throw new Error("SetAccessControl failed");
        },
        windowsDaclCache: expireCache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: expireAsyncHardening,
        windowsDaclCache: expireCache,
      }),
      removeDirectory: (root, targetToken) => {
        syncRemoves += 1;
        if (keepLocked) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        removeAgentSecretDirectory(root, targetToken);
      },
      removeDirectoryAsync: async (root, targetToken) => {
        asyncRemoves += 1;
        if (keepLocked) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        removeAgentSecretDirectory(root, targetToken);
      },
      resolve: async () => {
        throw new Error("Keychain locked");
      },
    });
    fourth.service.start();
    // Startup tried sync deletion once when hardening failed.
    expect(syncRemoves).toBe(1);
    expect(existsSync(thirdFile)).toBe(true);

    // Advance past TTL and sweep: expiration must NOT try sync removal and must try async removal exactly once.
    fourth.clock.now += 2 * 60 * 60_000;
    fourth.service.sweep();
    await vi.waitFor(() => expect(expireAsyncHardening).toHaveBeenCalledTimes(1));
    expect(fourth.store.transcriptRepository.secretRequests.find(thirdId)?.status).toBe("expired");
    expect(syncRemoves).toBe(1);
    expect(asyncRemoves).toBe(1);

    // Once unlocked, next sweep removes the expired unhardened file via async removal with zero sync calls.
    keepLocked = false;
    fourth.service.sweep();
    await vi.waitFor(() => expect(existsSync(thirdFile)).toBe(false));
    expect(syncRemoves).toBe(1);
    expect(asyncRemoves).toBe(2);
    third.service.shutdown();

    // S19: late keychain resolution after sweep expires an unhardened token while async removal is
    // in flight must route through discardRetainedFile (zero sync removal).
    const fifth = await openHarness();
    const fifthChat = chat(fifth.store, "LateResolveUnhardened");
    const fifthInvoke = fifth.service.invoke(fifthChat, call({ ...VALID, ttlHours: 1 }));
    const fifthId = pendingId(fifth.store);
    await fifth.service.deliver({ conversationId: fifthChat.conversation.id, requestId: fifthId, secret: SECRET, vaulted: true });
    const fifthFile = parsed(await fifthInvoke).file as string;
    services.splice(services.indexOf(fifth.service), 1);

    let lateSyncRemoves = 0;
    let lateAsyncRemoves = 0;
    const lateResolveGate: { resolve?: (value: string | null) => void; started?: () => void } = {};
    const lateResolveStarted = new Promise<void>((resolvePromise) => {
      lateResolveGate.started = resolvePromise;
    });
    const lateDeleteGate: { release?: () => void; started?: () => void } = {};
    const lateDeleteStarted = new Promise<void>((resolvePromise) => {
      lateDeleteGate.started = resolvePromise;
    });
    const lateCache: WindowsDaclCache = { hardenedRoots: new Map() };
    const sixth = await openHarness({
      directory: fifth.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: () => {
          throw new Error("SetAccessControl failed");
        },
        windowsDaclCache: lateCache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: async () => {
          throw new Error("SetAccessControl failed");
        },
        windowsDaclCache: lateCache,
      }),
      removeDirectory: (root, targetToken) => {
        lateSyncRemoves += 1;
        if (lateSyncRemoves === 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        removeAgentSecretDirectory(root, targetToken);
      },
      removeDirectoryAsync: async (root, targetToken) => {
        lateAsyncRemoves += 1;
        lateDeleteGate.started?.();
        await new Promise<void>((resolvePromise) => {
          lateDeleteGate.release = resolvePromise;
        });
        removeAgentSecretDirectory(root, targetToken);
      },
      resolve: () => new Promise<string | null>((resolvePromise) => {
        lateResolveGate.resolve = resolvePromise;
        lateResolveGate.started?.();
      }),
    });
    sixth.service.start();
    expect(lateSyncRemoves).toBe(1);

    const lateRestorePromise = sixth.service.restore();
    await lateResolveStarted;
    // Expire via sweep while keychain lookup is pending: starts async deletion (held at gate).
    sixth.clock.now += 2 * 60 * 60_000;
    sixth.service.sweep();
    await lateDeleteStarted;
    expect(lateSyncRemoves).toBe(1);
    expect(lateAsyncRemoves).toBe(1);

    // Late keychain lookup resolves while async removal is still in flight: must NOT call sync removeDirectory.
    lateResolveGate.resolve?.(SECRET);
    await lateRestorePromise;
    expect(lateSyncRemoves).toBe(1);
    expect(lateAsyncRemoves).toBe(1);

    lateDeleteGate.release?.();
    await vi.waitFor(() => expect(existsSync(fifthFile)).toBe(false));
    expect(lateSyncRemoves).toBe(1);
    fifth.service.shutdown();
  });

  it("coordinates revoke() with an in-flight sweep deletion and serializes it against restore (S20)", async () => {
    const first = await openHarness();
    const firstChat = chat(first.store, "RevokeDuringSweepDelete");
    const firstInvoke = first.service.invoke(firstChat, call(VALID));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: firstChat.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await firstInvoke).file as string;
    services.splice(services.indexOf(first.service), 1);

    let syncRemoves = 0;
    let asyncRemoves = 0;
    const writeCalls: string[] = [];
    const deleteGate: { release?: () => void; started?: () => void } = {};
    const deleteStarted = new Promise<void>((resolvePromise) => {
      deleteGate.started = resolvePromise;
    });
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    const second = await openHarness({
      directory: first.directory,
      start: false,
      platform: "win32",
      ensureRoot: (root, opts) => ensureAgentSecretRoot(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFile: () => {
          throw new Error("SetAccessControl failed");
        },
        windowsDaclCache: cache,
      }),
      ensureRootAsync: (root, opts) => ensureAgentSecretRootAsync(root, {
        ...opts,
        env: WIN32_TEST_ENV,
        execFileAsync: async () => {
          throw new Error("SetAccessControl failed");
        },
        windowsDaclCache: cache,
      }),
      removeDirectory: () => {
        syncRemoves += 1;
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
      removeDirectoryAsync: async (root, targetToken) => {
        asyncRemoves += 1;
        deleteGate.started?.();
        await new Promise<void>((resolvePromise) => {
          deleteGate.release = resolvePromise;
        });
        removeAgentSecretDirectory(root, targetToken);
      },
      writeFile: async (root, targetToken, fileName, value) => {
        writeCalls.push(targetToken);
        return await writeAgentSecretFile(root, targetToken, fileName, value);
      },
      resolve: async (reference) => (reference === agentSecretReference(requestId) ? SECRET : null),
    });
    second.service.start();
    expect(syncRemoves).toBe(1);

    // Sweep starts async deletion AND restore for the same token.
    second.service.sweep();
    await deleteStarted;
    expect(asyncRemoves).toBe(1);

    // Revoke joins the in-flight async deletion (no sync remove call!) and blocks restore from rewriting.
    const revokePromise = second.service.revoke(requestId);
    expect(syncRemoves).toBe(1);
    expect(asyncRemoves).toBe(1);

    deleteGate.release?.();
    await expect(revokePromise).resolves.toBe("revoked");
    expect(syncRemoves).toBe(1);
    expect(asyncRemoves).toBe(1);
    expect(writeCalls).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("revoked");
    first.service.shutdown();
  });

  it("serializes revoke() with an already-started restore write before deciding revoked vs in-use (S21)", async () => {
    const first = await openHarness();
    const source = chat(first.store, "RevokeDuringRestoreWrite");
    const invoke = first.service.invoke(source, call(VALID));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    const token = first.store.transcriptRepository.secretRequests.find(requestId)!.fileToken!;
    first.service.shutdown();

    const writeGate: { release?: () => void; started?: () => void } = {};
    const writeStarted = new Promise<void>((resolvePromise) => {
      writeGate.started = resolvePromise;
    });
    const second = await openHarness({
      directory: first.directory,
      resolve: async (reference) => (reference === agentSecretReference(requestId) ? SECRET : null),
      writeFile: async (root, targetToken, fileName, value) => {
        writeGate.started?.();
        await new Promise<void>((resolvePromise) => {
          writeGate.release = resolvePromise;
        });
        return await writeAgentSecretFile(root, targetToken, fileName, value);
      },
    });

    const restorePromise = second.service.restore();
    await writeStarted;

    // Lock the token so cleanup fails once the restore writer creates the file.
    second.locked.add(token);
    let revokeSettled = false;
    const revokePromise = second.service.revoke(requestId).then((outcome) => {
      revokeSettled = true;
      return outcome;
    });
    await Promise.resolve();
    await Promise.resolve();
    // Revoke must wait for the in-flight restore write instead of returning "revoked" early.
    expect(revokeSettled).toBe(false);

    // Resume the restore writer: it writes the file, then revoke attempts deletion, hits EBUSY,
    // and reports "in-use" while keeping the secret saved and redacted.
    writeGate.release?.();
    await restorePromise;
    await expect(revokePromise).resolves.toBe("in-use");
    expect(existsSync(file)).toBe(true);
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("saved");
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    // Once the lock clears, revoke deletes the file and transitions to "revoked".
    second.locked.delete(token);
    await expect(second.service.revoke(requestId)).resolves.toBe("revoked");
    expect(existsSync(file)).toBe(false);
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("revoked");
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe(`leaked ${SECRET}`);
  });

  it("cleans up or keeps redacting a recreated restore file when TTL expiry retires the request during revoke (S22)", async () => {
    const first = await openHarness();
    const source = chat(first.store, "ExpiryDuringRevoke");
    const invoke = first.service.invoke(source, call({ ...VALID, ttlHours: 1 }));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    const token = first.store.transcriptRepository.secretRequests.find(requestId)!.fileToken!;
    first.service.shutdown();

    const writeGate: { release?: () => void; started?: () => void } = {};
    const writeStarted = new Promise<void>((resolvePromise) => {
      writeGate.started = resolvePromise;
    });
    const second = await openHarness({
      directory: first.directory,
      resolve: async (reference) => (reference === agentSecretReference(requestId) ? SECRET : null),
      writeFile: async (root, targetToken, fileName, value) => {
        writeGate.started?.();
        await new Promise<void>((resolvePromise) => {
          writeGate.release = resolvePromise;
        });
        return await writeAgentSecretFile(root, targetToken, fileName, value);
      },
    });

    const restorePromise = second.service.restore();
    await writeStarted;

    // Start revoke (waits on in-flight restore write), then expire via TTL sweep before writer resumes.
    const revokePromise = second.service.revoke(requestId);
    await Promise.resolve();
    second.clock.now += 2 * 60 * 60_000;
    second.service.sweep();
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");

    // Lock the token before the writer recreates the file so cleanup hits EBUSY and must keep redacting.
    second.locked.add(token);
    writeGate.release?.();
    await restorePromise;
    await expect(revokePromise).resolves.toBe("not-active");
    expect(existsSync(file)).toBe(true);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    // Once unlocked, sweep removes the leftover recreated file and clears redaction.
    second.locked.delete(token);
    second.service.sweep();
    expect(existsSync(file)).toBe(false);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe(`leaked ${SECRET}`);
  });

  it("keeps redaction active after TTL expiry while a restore write has published the file and has not yet settled (S23)", async () => {
    const first = await openHarness();
    const source = chat(first.store, "ExpiryMidPublish");
    const invoke = first.service.invoke(source, call({ ...VALID, ttlHours: 1 }));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    first.service.shutdown();

    const prePublishGate: { release?: () => void; started?: () => void } = {};
    const prePublishStarted = new Promise<void>((resolvePromise) => {
      prePublishGate.started = resolvePromise;
    });
    const postPublishGate: { release?: () => void; published?: () => void } = {};
    const postPublishReached = new Promise<void>((resolvePromise) => {
      postPublishGate.published = resolvePromise;
    });
    const second = await openHarness({
      directory: first.directory,
      resolve: async (reference) => (reference === agentSecretReference(requestId) ? SECRET : null),
      writeFile: async (root, targetToken, fileName, value) => {
        prePublishGate.started?.();
        await new Promise<void>((resolvePromise) => {
          prePublishGate.release = resolvePromise;
        });
        // Publish the file to disk, then pause before writeFile settles (simulating post-rename chmod/sync).
        const written = await writeAgentSecretFile(root, targetToken, fileName, value);
        postPublishGate.published?.();
        await new Promise<void>((resolvePromise) => {
          postPublishGate.release = resolvePromise;
        });
        return written;
      },
    });

    const restorePromise = second.service.restore();
    await prePublishStarted;

    // Expire via TTL sweep while the file does not exist yet (deletion succeeds on absent directory).
    second.clock.now += 2 * 60 * 60_000;
    second.service.sweep();
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    // Now the writer publishes the file to disk and pauses before writeFile settles:
    // the file exists with the secret AND redaction must STILL be active!
    prePublishGate.release?.();
    await postPublishReached;
    expect(readFileSync(file, "utf8")).toBe(SECRET);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe("leaked [redacted]");

    // Once writeFile settles, restore cleans up the retired file and drops redaction.
    postPublishGate.release?.();
    await restorePromise;
    expect(existsSync(file)).toBe(false);
    expect(second.service.output.text(`leaked ${SECRET}`)).toBe(`leaked ${SECRET}`);
  });

  it("expires queued and in-flight restores past TTL on sweep, removes retained files, discards late resolve results, and bounds whenRestored", async () => {
    const first = await openHarness();
    const source = chat(first.store, "SlowRestore");
    const invoke = first.service.invoke(source, call({ ...VALID, ttlHours: 1 }));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    // Leave file on disk as after a crash.
    services.splice(services.indexOf(first.service), 1);

    let release!: (value: string | null) => void;
    const second = await openHarness({
      directory: first.directory,
      resolve: () => new Promise<string | null>((resolve) => {
        release = resolve;
      }),
    });
    const restoring = second.service.restore();
    await vi.waitFor(() => expect(second.resolveVault).toHaveBeenCalledWith(agentSecretReference(requestId)));

    // whenRestored respects its bounded timeout when the keychain hangs.
    const startedAt = Date.now();
    await second.service.whenRestored(25);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    // Advance past expiry while resolve() is still in flight; sweep must expire it immediately
    // and delete the retained file instead of keeping it alive under a locked/hanging keychain.
    second.clock.now = first.clock.now + 2 * 60 * 60_000;
    second.service.sweep();
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
    expect(existsSync(file)).toBe(false);

    // Late resolve result must be discarded without resurrecting the file or DB row.
    release(SECRET);
    await restoring;
    expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
    expect(existsSync(file)).toBe(false);
    first.service.shutdown();
  });

  it("expires a stalled in-flight restore via the expiry timer without calling sweep()", async () => {
    const first = await openHarness();
    const source = chat(first.store, "StalledTimerRestore");
    const invoke = first.service.invoke(source, call({ ...VALID, ttlHours: 1 }));
    const requestId = pendingId(first.store);
    await first.service.deliver({ conversationId: source.conversation.id, requestId, secret: SECRET, vaulted: true });
    const file = parsed(await invoke).file as string;
    services.splice(services.indexOf(first.service), 1);

    vi.useFakeTimers();
    try {
      let release!: (value: string | null) => void;
      const second = await openHarness({
        directory: first.directory,
        sweepIntervalMs: 24 * 60 * 60_000,
        resolve: () => new Promise<string | null>((resolve) => {
          release = resolve;
        }),
      });
      const restoring = second.service.restore();
      await Promise.resolve();
      expect(second.resolveVault).toHaveBeenCalledWith(agentSecretReference(requestId));

      // Advance clock and fake timers past the 1-hour TTL without calling sweep().
      second.clock.now = first.clock.now + 60 * 60_000 + 1_000;
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
      expect(existsSync(file)).toBe(false);

      release(SECRET);
      await restoring;
      expect(second.store.transcriptRepository.secretRequests.find(requestId)?.status).toBe("expired");
      expect(existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
      first.service.shutdown();
    }
  });

  it("keeps a transiently failed restore's expiry timer active while a later restore stalls", async () => {
    const first = await openHarness();
    const firstChat = chat(first.store, "RetryShortTtl");
    const firstInvoke = first.service.invoke(firstChat, call({ ...VALID, ttlHours: 1 }));
    const firstId = pendingId(first.store);
    await first.service.deliver({ conversationId: firstChat.conversation.id, requestId: firstId, secret: SECRET, vaulted: true });
    const firstFile = parsed(await firstInvoke).file as string;

    const secondChat = chat(first.store, "StalledLongTtl");
    const secondInvoke = first.service.invoke(secondChat, call({ ...VALID, ttlHours: 4 }));
    const secondId = first.store.transcriptRepository.secretRequests.pendingAll().find(({ id }) => id !== firstId)!.id;
    await first.service.deliver({
      conversationId: secondChat.conversation.id,
      requestId: secondId,
      secret: "ghp_secondLongTtlSecret99",
      vaulted: true,
    });
    const secondFile = parsed(await secondInvoke).file as string;
    services.splice(services.indexOf(first.service), 1);

    vi.useFakeTimers();
    try {
      let releaseSecond!: (value: string | null) => void;
      const second = await openHarness({
        directory: first.directory,
        sweepIntervalMs: 24 * 60 * 60_000,
        resolve: async (reference) => {
          if (reference === agentSecretReference(firstId)) {
            throw new Error("Keychain temporarily locked");
          }
          return await new Promise<string | null>((resolve) => {
            releaseSecond = resolve;
          });
        },
      });
      const restoring = second.service.restore();
      await vi.waitFor(() => expect(second.resolveVault).toHaveBeenCalledWith(agentSecretReference(secondId)));

      // First request is sitting in runRestore()'s local retry list while second stalls.
      // Advancing past the first request's 1h TTL without calling sweep() must expire it
      // and delete its retained file while leaving the longer-lived second request untouched.
      second.clock.now = first.clock.now + 60 * 60_000 + 1_000;
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      expect(second.store.transcriptRepository.secretRequests.find(firstId)?.status).toBe("expired");
      expect(existsSync(firstFile)).toBe(false);
      expect(second.store.transcriptRepository.secretRequests.find(secondId)?.status).toBe("saved");
      expect(existsSync(secondFile)).toBe(true);

      releaseSecond("ghp_secondLongTtlSecret99");
      await restoring;
      expect(second.store.transcriptRepository.secretRequests.find(firstId)?.status).toBe("expired");
      expect(second.store.transcriptRepository.secretRequests.find(secondId)?.status).toBe("saved");
    } finally {
      vi.useRealTimers();
      first.service.shutdown();
    }
  });

  it("removes retained files on revoke and revokeForConversation during startup restore and returns in-use when locked", async () => {
    const first = await openHarness();
    const c1 = chat(first.store, "RevokeDuringRestore");
    const inv1 = first.service.invoke(c1, call(VALID));
    const req1 = pendingId(first.store);
    await first.service.deliver({ conversationId: c1.conversation.id, requestId: req1, secret: SECRET, vaulted: true });
    const file1 = parsed(await inv1).file as string;

    const c2 = chat(first.store, "DeleteChatDuringRestore");
    const inv2 = first.service.invoke(c2, call(VALID));
    const req2 = pendingId(first.store);
    await first.service.deliver({ conversationId: c2.conversation.id, requestId: req2, secret: "ghp_secondSecret99999", vaulted: true });
    const file2 = parsed(await inv2).file as string;
    // Simulate crash leaving retained files on disk before restart.
    services.splice(services.indexOf(first.service), 1);

    const token1 = first.store.transcriptRepository.secretRequests.find(req1)!.fileToken!;
    const second = await openHarness({
      directory: first.directory,
      vault: { [agentSecretReference(req1)]: SECRET, [agentSecretReference(req2)]: "ghp_secondSecret99999" },
    });
    expect(existsSync(file1)).toBe(true);
    expect(existsSync(file2)).toBe(true);

    // Direct revoke while file is locked returns in-use and keeps status saved.
    second.locked.add(token1);
    await expect(second.service.revoke(req1)).resolves.toBe("in-use");
    expect(second.store.transcriptRepository.secretRequests.find(req1)?.status).toBe("saved");
    expect(existsSync(file1)).toBe(true);

    // Once unlocked, direct revoke deletes the retained file and retires the record.
    second.locked.delete(token1);
    await expect(second.service.revoke(req1)).resolves.toBe("revoked");
    expect(second.store.transcriptRepository.secretRequests.find(req1)?.status).toBe("revoked");
    expect(existsSync(file1)).toBe(false);

    // revokeForConversation also removes the retained file before restore runs.
    second.service.revokeForConversation(c2.conversation.id);
    expect(second.store.transcriptRepository.secretRequests.find(req2)?.status).toBe("revoked");
    expect(existsSync(file2)).toBe(false);
    first.service.shutdown();
  });

  it("treats retrying deliver with the exact committed secret as idempotent while rejecting a different secret", async () => {
    const harness = await openHarness();
    const source = chat(harness.store, "IdempotentDeliver");
    const invoke = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    const firstOutcome = await harness.service.deliver({
      conversationId: source.conversation.id,
      requestId,
      secret: SECRET,
      vaulted: true,
    });
    await invoke;
    expect(firstOutcome).toMatchObject({ status: "delivered", storage: "keychain" });

    // Retrying with the exact same secret returns the committed outcome idempotently.
    await expect(harness.service.deliver({
      conversationId: source.conversation.id,
      requestId,
      secret: SECRET,
      vaulted: true,
    })).resolves.toEqual(firstOutcome);

    // Retrying with a different secret rejects as not-pending.
    await expect(harness.service.deliver({
      conversationId: source.conversation.id,
      requestId,
      secret: "different-secret-value-1234",
      vaulted: false,
    })).resolves.toEqual({ status: "rejected", reason: "not-pending" });
  });

  it("abandons an in-flight delivery immediately after writeFile when shutdown raced without touching DB or lingering", async () => {
    const writer = gatedWriter();
    const harness = await openHarness({ writeFile: writer.writeFile });
    const source = chat(harness.store);
    const invoke = harness.service.invoke(source, call(VALID));
    const requestId = pendingId(harness.store);
    const delivery = harness.service.deliver({
      conversationId: source.conversation.id,
      requestId,
      secret: SECRET,
      vaulted: true,
    });
    await writer.written;
    const transitionSpy = vi.spyOn(harness.store.transcriptRepository.secretRequests, "transition");
    harness.service.shutdown();
    transitionSpy.mockClear();
    writer.release();

    await expect(delivery).resolves.toEqual({ status: "rejected", reason: "ended" });
    await invoke;
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(harness.service.output.values()).toEqual([]);
    expect(readdirSync(agentSecretRoot(harness.directory))).toEqual([]);
  });
});
