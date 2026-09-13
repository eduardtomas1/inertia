// @inertia-test-suite portable
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const discoveryFixture = vi.hoisted(() => ({ directory: "" }));

vi.mock("../../src/server/environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/environment")>();
  return {
    ...actual,
    // Production discovery adds common host CLI locations to PATH. This smoke
    // owns only its fixture provider; Git remains available in the child PATH.
    providerEnvironment: async () => ({
      env: { ...process.env },
      pathEntries: [discoveryFixture.directory],
    }),
  };
});

import type { RunningRuntime } from "../../src/server";
import type { AgentTurn, ChatMessage, Conversation, Project, ServerEvent } from "../../src/shared/contracts";
import { portableNodeExecutable, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";
import { startTestRuntime } from "../support/test-runtime";
import { connectRuntime } from "../support/runtime-event-queue";

interface Proof {
  project: Partial<Project> & { id: string };
  conversation: Partial<Conversation> & { id: string };
  messages: ChatMessage[];
  agentTurns: AgentTurn[];
}
interface Baseline extends Proof {
  attachment: { id: string; size: number; digest: string };
  attachmentBytes: string;
  runtimeRecovery?: unknown;
}
const runtimeUrl = pathToFileURL(resolve("scripts/package-smoke-history-runtime.mjs")).href;
const storageUrl = pathToFileURL(resolve("scripts/package-smoke-history-storage.mjs")).href;
const pathUrl = pathToFileURL(resolve("scripts/package-smoke-path.mjs")).href;
async function modules() {
  const runtime = await import(runtimeUrl) as {
    runPackagedHistorySmoke: (options: { websocketUrl: string; workspaceDirectory: string;
      baseline?: Baseline; deadlineAt?: number }) => Promise<Proof>;
    completedTurnProof: (detail: unknown, acceptance: unknown, challenge: string) => Proof | null;
    completedTurnAdmissionProof: (snapshot: unknown, turn: AgentTurn) => boolean;
  };
  const storage = await import(storageUrl) as {
    prepareHistoryBaseline: (root: string, path: string, proof: Proof) => Promise<Baseline>;
    readHistoryBaseline: (path: string) => Promise<Baseline>;
    assertHistoryAttachment: (root: string, baseline: Baseline) => Promise<void>;
    assertHistoryAfterShutdown: (root: string, proof: Proof, baseline?: Baseline) => Promise<void>;
    readWindowsSystemBootId: (options?: unknown) => string;
    prepareWindowsLegacyZeroPidRecoveryFixture: (root: string, systemBootId: string) => Promise<{
      files: { path: string; sha256: string }[];
      directories: string[];
      generationIds: string[];
      systemBootId: string;
      version: number;
    }>;
    assertWindowsLegacyZeroPidRecoveryFixture: (root: string, fixture: unknown) => Promise<void>;
    assertWindowsLegacyZeroPidRecoveryRetired: (root: string, fixture: unknown) => Promise<void>;
  };
  return { ...runtime, ...storage };
}

it("seeds the exact same-boot Windows zero-PID recovery history and rejects damage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-installed-zero-pid-")));
  roots.push(root);
  await mkdir(join(root, "data"));
  const smoke = await modules();
  const bootId = smoke.readWindowsSystemBootId({
    environment: { SystemRoot: "C:\\Windows" },
    spawn: vi.fn(() => ({ status: 0, error: undefined,
      stdout: "BootId    REG_DWORD    0x191\r\n" })),
  });
  expect(bootId).toBe("win32:00000191");
  const fixture = await smoke.prepareWindowsLegacyZeroPidRecoveryFixture(root, bootId);
  expect(fixture).toMatchObject({ version: 1, systemBootId: bootId });
  expect(fixture.generationIds).toHaveLength(2);
  expect(fixture.files).toHaveLength(8);
  expect(fixture.directories).toHaveLength(2);
  expect(fixture.directories.map((path) => path.split(/[\\/]/u).at(-1)).sort())
    .toEqual(expect.arrayContaining([
      expect.stringMatching(/\.active$/u),
      expect.stringMatching(/\.retire$/u),
    ]));
  const childRecords = await Promise.all(fixture.files
    .filter(({ path }) => path.includes(".runtime-owned-child-"))
    .map(async ({ path }) => JSON.parse(await readFile(join(root, path), "utf8"))));
  expect(childRecords).toHaveLength(2);
  for (const record of childRecords) {
    expect(record).toMatchObject({
      version: 1,
      state: "owned",
      runtimeGenerationId: fixture.generationIds[0],
      systemBootId: bootId,
      process: {
        platform: "win32",
        pid: 0,
        processGroupId: null,
        startedAfterMs: expect.any(Number),
        startedBeforeMs: expect.any(Number),
      },
    });
  }
  const containmentRecords = await Promise.all(fixture.files
    .filter(({ path }) => path.includes(".runtime-owned-process-containment-"))
    .map(async ({ path }) => JSON.parse(await readFile(join(root, path), "utf8"))));
  for (const record of containmentRecords) {
    const digest = createHash("sha256").update(record.runtimeGenerationId).digest("hex");
    expect(record).toMatchObject({ version: 1, systemBootId: bootId,
      containment: { kind: "windows-job-v1", name: `Global\\InertiaRuntime-${digest}` } });
  }
  await smoke.assertWindowsLegacyZeroPidRecoveryFixture(root, fixture);

  const damaged = join(root, fixture.files[0]!.path);
  await writeFile(damaged, "{}", { flag: "w" });
  await expect(smoke.assertWindowsLegacyZeroPidRecoveryFixture(root, fixture))
    .rejects.toThrow("changed before launch");
  await expect(smoke.assertWindowsLegacyZeroPidRecoveryRetired(root, fixture))
    .rejects.toThrow("was not retired");
  for (const entry of [...fixture.files.map(({ path }) => path), ...fixture.directories]) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
  await smoke.assertWindowsLegacyZeroPidRecoveryRetired(root, fixture);
});
const roots: string[] = [];
const runtimes: RunningRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  discoveryFixture.directory = "";
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-installed-history-")));
  roots.push(root);
  const workspaceDirectory = join(root, "workspace");
  await mkdir(workspaceDirectory);
  const bin = join(root, "provider");
  await mkdir(bin);
  discoveryFixture.directory = bin;
  const executable = portableNodeExecutable(bin, "codex");
  const { packageSmokePath } = await import(pathUrl) as {
    packageSmokePath: (directory: string, options: { includeGit: boolean }) => Promise<string>;
  };
  // Exercise the same isolated executable search path as the installed smoke.
  // Without its explicit Git directory, conversation.create fails before a turn.
  const isolatedPath = await packageSmokePath(bin, { includeGit: true });
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase() === "PATH") vi.stubEnv(name, undefined);
  }
  vi.stubEnv("PATH", isolatedPath);
  writeNodeSubcommand(workspaceDirectory, "login", `
if (process.argv[2] !== "status") process.exit(2);
console.log("Logged in using ChatGPT");
`);
  writeNodeSubcommand(workspaceDirectory, "app-server", await readFile(
    resolve("scripts/package-smoke-codex-fixture.cjs"), "utf8"));
  const systemBootId = `test:${randomUUID()}`;
  // These runtime instances reopen in one actual Node process. Its generation
  // lease stays constant; native installer CI proves separate process cleanup.
  const runtimeGenerationId = `${systemBootId.slice(5)}:1`;
  const launch = async () => {
    const runtime = await startTestRuntime({
      dataDirectory: join(root, "data"), defaultWorkspacePath: workspaceDirectory,
      enableProviders: true, codexBinaryPath: executable,
      runtimeGenerationId, systemBootId,
      secureFiles: new SecureFileTestBroker(),
    });
    runtimes.push(runtime);
    const client = await connectRuntime(runtime.websocketUrl);
    try {
      await client.events.next((event): event is ServerEvent => (
        (event.type === "server.welcome" || event.type === "snapshot.updated")
        && event.snapshot.providers.some((provider) => provider.id === "codex" && provider.canRun)
      ));
    } finally { client.socket.close(); }
    return runtime;
  };
  const close = async (runtime: RunningRuntime) => {
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
  };
  return { root, workspaceDirectory, launch, close,
    databasePath: join(root, "data", "inertia.sqlite"),
    baselinePath: join(root, "upgrade-history.json") };
}

it("reopens history, switches speed, compacts, resumes, and persists every completed turn", async () => {
  const f = await fixture();
  const smoke = await modules();
  const predecessor = await f.launch();
  const oldProof = await smoke.runPackagedHistorySmoke({
    websocketUrl: predecessor.websocketUrl, workspaceDirectory: f.workspaceDirectory,
  });
  // v0.0.48 did not project this subsequently added field. Additional fields
  // after migration must not hide a mismatch in any field N-1 did provide.
  delete oldProof.agentTurns[0]!.continuationReasonCode;
  const image = join(f.root, "old-image.png");
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(randomUUID())]);
  await writeFile(image, bytes);
  await predecessor.runPackageSmokeImage!(image, join(f.root, "old-image-result.json"));
  await f.close(predecessor);
  const schemaVersion = () => {
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    try { return db.prepare("PRAGMA schema_version").get(); } finally { db.close(); }
  };
  const schemaBefore = schemaVersion();
  const baseline = await smoke.prepareHistoryBaseline(f.root, f.baselinePath, oldProof);
  expect(schemaVersion()).toEqual(schemaBefore);
  expect(baseline.attachment.id).not.toBe("00000000-0000-4000-8000-000000000018");
  expect(baseline.attachmentBytes).toBe(bytes.toString("base64"));
  const unchangedBaseline = await readFile(f.baselinePath);
  expect(await smoke.readHistoryBaseline(f.baselinePath)).toEqual(baseline);

  const candidate = await f.launch();
  // The ordinary image smoke writes a different fixed-ID fixture. It cannot
  // repair the independently identified historical attachment being asserted.
  await writeFile(image, Buffer.concat([bytes, Buffer.from("candidate")]));
  await candidate.runPackageSmokeImage!(image, join(f.root, "new-image-result.json"));
  const newProof = await smoke.runPackagedHistorySmoke({
    websocketUrl: candidate.websocketUrl, workspaceDirectory: f.workspaceDirectory, baseline,
  });
  await f.close(candidate);
  await smoke.assertHistoryAfterShutdown(f.root, newProof, baseline);
  expect(newProof.agentTurns[0]!.id).not.toBe(oldProof.agentTurns[0]!.id);
  expect(newProof.agentTurns).toHaveLength(4);
  expect(newProof.agentTurns.map((turn) =>
    turn.modelSelection.providerOptions.fastMode ?? null))
    .toEqual(["priority", null, "priority", "priority"]);
  expect(new Set(newProof.agentTurns.flatMap((turn) => [
    turn.providerSessionBefore,
    turn.providerSessionAfter,
  ]).filter(Boolean))).toEqual(new Set([
    newProof.agentTurns[0]!.providerSessionAfter,
  ]));
  expect(newProof.messages[1]!.content)
    .toMatch(/^Completed package-smoke-candidate-fast:/u);
  expect(newProof.messages.at(-1)!.content)
    .toMatch(/^Completed package-smoke-candidate-fast:/u);
  expect(await readFile(f.baselinePath)).toEqual(unchangedBaseline);

  const db = new DatabaseSync(f.databasePath);
  const oldMessage = baseline.messages[0]!;
  const replacement = "same identity, damaged historical content";
  try { db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(replacement, oldMessage.id); }
  finally { db.close(); }
  await expect(smoke.assertHistoryAfterShutdown(f.root, newProof, baseline))
    .rejects.toThrow("Saved message/content/attachments");
  const damaged = await f.launch();
  await expect(smoke.runPackagedHistorySmoke({
    websocketUrl: damaged.websocketUrl, workspaceDirectory: f.workspaceDirectory, baseline,
  })).rejects.toThrow("Historical saved message/content/attachment changed");
  await f.close(damaged);
  const readDb = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    expect(readDb.prepare("SELECT COUNT(*) AS count FROM agent_turns").get()).toEqual({ count: 5 });
  }
  finally { readDb.close(); }

  const attachmentPath = join(f.root, "data", "conversation-attachments", baseline.attachment.id,
    `${baseline.attachment.id}.png`);
  await writeFile(attachmentPath, Buffer.alloc(bytes.length));
  await expect(smoke.assertHistoryAttachment(f.root, baseline)).rejects.toThrow("Historical attachment bytes");
  await rm(attachmentPath);
  await expect(smoke.assertHistoryAttachment(f.root, baseline)).rejects.toThrow();
});

it("rejects READY-only, failed, misowned and fabricated terminal responses", async () => {
  const { completedTurnProof } = await modules();
  const acceptance = { kind: "message.accepted", disposition: "new-turn",
    conversationId: "conversation", turnId: "turn", userMessageId: "user" };
  const turn = { id: "turn", conversationId: "conversation", userMessageId: "user",
    terminalAssistantMessageId: "assistant", status: "completed", startedAt: "start",
    completedAt: "end", runId: "run", providerSessionAfter: "thread", providerId: "codex" };
  const messages = [
    { id: "user", role: "user", conversationId: "conversation", turnId: "turn", content: "challenge" },
    { id: "assistant", role: "assistant", conversationId: "conversation", turnId: "turn", content: "Completed challenge" },
  ];
  expect(completedTurnProof({ agentTurns: [], messages: [] }, acceptance, "challenge")).toBeNull();
  expect(completedTurnProof({ agentTurns: [{ ...turn, status: "starting" }], messages }, acceptance, "challenge")).toBeNull();
  expect(completedTurnProof({ agentTurns: [{ ...turn, status: "running" }], messages }, acceptance, "challenge")).toBeNull();
  for (const change of [{ status: "failed" }, { conversationId: "other" }, { userMessageId: "other" },
    { startedAt: null }, { completedAt: null }, { providerSessionAfter: null }]) {
    expect(() => completedTurnProof({ agentTurns: [{ ...turn, ...change }], messages }, acceptance, "challenge"))
      .toThrow("did not complete");
  }
  expect(() => completedTurnProof({ agentTurns: [turn], messages }, acceptance, "different challenge"))
    .toThrow("submitted message");
  expect(() => completedTurnProof({ agentTurns: [turn], messages: [messages[0]] }, acceptance, "challenge"))
    .toThrow("terminal response");
  expect(() => completedTurnProof({ agentTurns: [turn], messages }, null, "challenge"))
    .toThrow("durably accept");
});

it("waits for exact public runtime admission idle after terminal persistence", async () => {
  const { completedTurnAdmissionProof } = await modules();
  const turn = {
    id: "turn",
    conversationId: "conversation",
    runId: "run",
  } as AgentTurn;
  const idle = {
    conversations: [{
      id: "conversation",
      status: "completed",
      latestTurn: { id: "turn", status: "completed" },
    }],
    runs: [{
      id: "run",
      status: "succeeded",
      finishedAt: "2026-09-06T18:30:00.000Z",
      canStop: false,
    }],
    lifecycleDiagnostics: {
      ownedResources: {
        providerRuns: 0,
        turns: 0,
        workspaceRuns: 0,
        interactions: 0,
      },
    },
  };
  expect(completedTurnAdmissionProof(idle, turn)).toBe(true);
  expect(completedTurnAdmissionProof({
    ...idle,
    runs: [{ ...idle.runs[0], status: "running", finishedAt: null, canStop: true }],
  }, turn)).toBe(false);
  expect(completedTurnAdmissionProof({
    ...idle,
    runs: [{ ...idle.runs[0], finishedAt: undefined }],
  }, turn)).toBe(false);
  expect(completedTurnAdmissionProof({
    ...idle,
    lifecycleDiagnostics: {
      ownedResources: {
        ...idle.lifecycleDiagnostics.ownedResources,
        turns: 1,
      },
    },
  }, turn)).toBe(false);
});

it.each([false, true])("bounds a terminal turn whose public runtime ownership never becomes idle (malformed state: %s)", async (malformedState) => {
  const { runPackagedHistorySmoke } = await modules();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const projectId = randomUUID();
  const conversationId = randomUUID();
  let modelSelection = {
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: "provider-native:codex",
    backendProfileDisplayName: "Codex",
    backendConfigurationRevision: 1,
    modelId: "package-smoke-model",
    alias: null,
    reasoningEffort: "low",
    providerOptions: {},
    capabilities: [],
  };
  let challenge = "";
  const messageActivations: Array<boolean | undefined> = [];
  try {
    await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "server.welcome",
        snapshot: {
          projects: [], settings: {},
          conversations: [{ id: conversationId, status: malformedState ? "PRIVATE status" : "completed",
            latestTurn: { id: "turn-terminal-not-idle", status: "completed" },
            title: "PRIVATE conversation text" }],
          runs: [{ id: "run-terminal-not-idle", status: malformedState ? "PRIVATE run status" : "running",
            canStop: malformedState ? "PRIVATE stop" : true,
            providerOutput: "PRIVATE provider output" }],
          lifecycleDiagnostics: { ownedResources: {
            providerRuns: 1, turns: 1, workspaceRuns: 0, interactions: 0,
            privatePath: "/PRIVATE/profile" } },
        },
      }));
      socket.on("message", (bytes) => {
        const command = JSON.parse(bytes.toString("utf8")) as {
          type: string;
          requestId: string;
          payload?: {
            content?: string;
            activate?: boolean;
            modelSelection?: typeof modelSelection;
          };
        };
        const respond = (result: unknown) => socket.send(JSON.stringify({
          type: "request.result",
          requestId: command.requestId,
          result,
        }));
        if (command.type === "provider.refresh" || command.type === "settings.update") {
          respond(null);
          return;
        }
        if (command.type === "project.create") {
          respond({ kind: "project.created", projectId });
          return;
        }
        if (command.type === "conversation.create") {
          respond({ kind: "conversation.created", conversationId });
          return;
        }
        if (command.type === "conversation.update") {
          modelSelection = command.payload!.modelSelection!;
          respond(null);
          return;
        }
        if (command.type === "message.send") {
          challenge = command.payload!.content!;
          messageActivations.push(command.payload!.activate);
          respond({
            kind: "message.accepted",
            disposition: "new-turn",
            conversationId,
            turnId: "turn-terminal-not-idle",
            userMessageId: "user-terminal-not-idle",
          });
          return;
        }
        if (command.type === "conversation.detail.load") {
          const turn = challenge ? {
            id: "turn-terminal-not-idle",
            conversationId,
            runId: "run-terminal-not-idle",
            userMessageId: "user-terminal-not-idle",
            terminalAssistantMessageId: "assistant-terminal-not-idle",
            providerId: "codex",
            modelSelection,
            providerSessionBefore: null,
            providerSessionAfter: "thread-terminal-not-idle",
            status: "completed",
            startedAt: "2026-09-06T18:30:00.000Z",
            completedAt: "2026-09-06T18:30:01.000Z",
            terminalReason: "provider-completed",
          } : null;
          respond({
            kind: "conversation.detail",
            state: "ready",
            conversationId,
            detail: {
              conversation: { id: conversationId, projectId, modelSelection },
              agentTurns: turn ? [turn] : [],
              messages: turn ? [{
                id: turn.userMessageId,
                role: "user",
                conversationId,
                turnId: turn.id,
                content: challenge,
              }, {
                id: turn.terminalAssistantMessageId,
                role: "assistant",
                conversationId,
                turnId: turn.id,
                content: `Completed ${challenge}`,
              }] : [],
            },
          });
          return;
        }
        socket.send(JSON.stringify({
          type: "request.error",
          requestId: command.requestId,
          message: `Unexpected command: ${command.type}`,
        }));
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port.");
    const startedAt = Date.now();
    const error = await runPackagedHistorySmoke({
      websocketUrl: `ws://127.0.0.1:${address.port}`,
      workspaceDirectory: tmpdir(),
      deadlineAt: startedAt + 250,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("exceeded its deadline");
    const diagnostic = JSON.parse(message.split(" Proof state: ")[1]!);
    expect(diagnostic).toMatchObject({
      phase: "admission-idle", turnNumber: 1, completedTurns: 0,
      initialBudgetMs: expect.any(Number), elapsedMs: expect.any(Number), phaseElapsedMs: expect.any(Number),
      pendingCommands: [], turnStatus: "completed", conversationStatus: malformedState ? "unknown" : "completed",
      latestTurnMatches: true, runStatus: malformedState ? "unknown" : "running", runCanStop: malformedState ? null : true,
      ownedResources: { providerRuns: 1, turns: 1, workspaceRuns: 0, interactions: 0 },
    });
    expect(message).not.toMatch(/PRIVATE|ws:\/\/|turn-terminal-not-idle|run-terminal-not-idle/u);
    expect(message).not.toContain(conversationId);
    expect(messageActivations).toEqual([false]);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

it("reports the pending proof phase without exposing malformed snapshot state", async () => {
  const { runPackagedHistorySmoke } = await modules();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "server.welcome", snapshot: {
        conversations: [null, { status: "PRIVATE status", id: "PRIVATE id" }],
        runs: "PRIVATE run data", providerOutput: "PRIVATE output",
        lifecycleDiagnostics: { ownedResources: {
          providerRuns: "PRIVATE count", turns: -1, workspaceRuns: 1.5, interactions: 1_000_001,
        } },
      } }));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port.");
    const error = await runPackagedHistorySmoke({
      websocketUrl: `ws://127.0.0.1:${address.port}`, workspaceDirectory: tmpdir(),
      deadlineAt: Date.now() + 200,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const diagnostic = JSON.parse(message.split(" Proof state: ")[1]!);
    expect(diagnostic).toMatchObject({
      phase: "provider-refresh", turnNumber: 0, completedTurns: 0,
      pendingCommands: ["provider.refresh"], turnStatus: "unknown", conversationStatus: "unknown",
      latestTurnMatches: false, runStatus: "unknown", runCanStop: null,
      ownedResources: { providerRuns: null, turns: null, workspaceRuns: null, interactions: null },
    });
    expect(message).not.toMatch(/PRIVATE|ws:\/\//u);
    expect(Buffer.byteLength(message)).toBeLessThan(1_024);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

it.each(["stall", "close", "malformed"] as const)("fails closed when the history transport %s prevents proof", async (mode) => {
  const { runPackagedHistorySmoke } = await modules();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
    server.on("connection", (socket) => {
      if (mode === "close") socket.close();
      else if (mode === "malformed") socket.send("invalid JSON");
      else socket.send(JSON.stringify({ type: "server.welcome", snapshot: {} }));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port.");
    await expect(runPackagedHistorySmoke({ websocketUrl: `ws://127.0.0.1:${address.port}`,
      workspaceDirectory: tmpdir(), deadlineAt: Date.now() + 200 })).rejects.toThrow();
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
