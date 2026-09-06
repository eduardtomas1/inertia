// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";

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
}
const runtimeUrl = pathToFileURL(resolve("scripts/package-smoke-history-runtime.mjs")).href;
const storageUrl = pathToFileURL(resolve("scripts/package-smoke-history-storage.mjs")).href;
async function modules() {
  const runtime = await import(runtimeUrl) as {
    runPackagedHistorySmoke: (options: { websocketUrl: string; workspaceDirectory: string;
      baseline?: Baseline; deadlineAt?: number }) => Promise<Proof>;
    completedTurnProof: (detail: unknown, acceptance: unknown, challenge: string) => Proof | null;
  };
  const storage = await import(storageUrl) as {
    prepareHistoryBaseline: (root: string, path: string, proof: Proof) => Promise<Baseline>;
    readHistoryBaseline: (path: string) => Promise<Baseline>;
    assertHistoryAttachment: (root: string, baseline: Baseline) => Promise<void>;
    assertHistoryAfterShutdown: (root: string, proof: Proof, baseline?: Baseline) => Promise<void>;
  };
  return { ...runtime, ...storage };
}
const roots: string[] = [];
const runtimes: RunningRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-installed-history-")));
  roots.push(root);
  const workspaceDirectory = join(root, "workspace");
  await mkdir(workspaceDirectory);
  const bin = join(root, "provider");
  await mkdir(bin);
  const executable = portableNodeExecutable(bin, "codex");
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

it("reopens real saved records and independent attachment bytes, then persists a new completed turn", async () => {
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
  expect(newProof.messages[1]!.content).toMatch(/^Completed package-smoke-candidate:/u);
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
    expect(readDb.prepare("SELECT COUNT(*) AS count FROM agent_turns").get()).toEqual({ count: 2 });
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
