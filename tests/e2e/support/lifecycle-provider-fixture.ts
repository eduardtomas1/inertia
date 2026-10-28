import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { RuntimeStore } from "../../../src/server/database";
import { providerNativeModelSelection } from "../../../src/shared/model-routing";
import { writeNodeFlagExecutable } from "../../helpers/portable-provider-fixture";
import type { AppFixture } from "./app-fixture";

export const LIFECYCLE_PROVIDER_OUTPUT = "Lifecycle fixture is working.";
export const LIFECYCLE_PROVIDER_DONE = "Lifecycle fixture finished.";

export interface LifecycleProviderEvent {
  pid: number;
  parentPid: number;
  event: "started" | "turn" | "interrupt" | "command" | "completed";
  at: number;
}

const recorder = (eventsPath: string): string => `
const fs = require("node:fs");
const record = (event) => fs.appendFileSync(${eventsPath},
  JSON.stringify({ pid: process.pid, parentPid: process.ppid, event, at: Date.now() }) + "\\n");
const lifetime = setTimeout(() => process.exit(0), 180000);
lifetime.unref();
`;

export const lifecycleCodexAppServer = `
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
${recorder('path.join(process.cwd(), ".git", "lifecycle-provider.jsonl")')}
record("started");
let threadId = "lifecycle-thread";
let activeTurnId = null;
let turnSequence = 0;
let holding = false;
let streamTimer = null;
const delta = (text) => send({ method: "item/agentMessage/delta", params: {
  threadId, turnId: activeTurnId, itemId: "lifecycle-answer-" + turnSequence, delta: text,
} });
const complete = (status) => {
  if (!activeTurnId) return;
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = null;
  record("completed");
  send({ method: "turn/completed", params: {
    threadId, turn: { id: activeTurnId, status, items: [], error: null },
  } });
  activeTurnId = null;
};
const lines = readline.createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "lifecycle-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null,
    } });
  }
  if (message.method === "turn/interrupt") {
    record("interrupt");
    if (holding) return;
    send({ id: message.id, result: {} });
    complete("interrupted");
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  activeTurnId = "lifecycle-turn-" + turnSequence;
  const prompt = (message.params.input || []).filter((item) => item.type === "text")
    .map((item) => item.text).join("\\n");
  record("turn");
  const turn = { id: activeTurnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  delta(${JSON.stringify(LIFECYCLE_PROVIDER_OUTPUT)});
  holding = prompt.includes("lifecycle:hold");
  if (prompt.includes("lifecycle:run-command")) {
    spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    record("command");
  }
  const streamFor = /lifecycle:stream=(\\d+)/u.exec(prompt);
  if (streamFor) {
    const until = Date.now() + Number(streamFor[1]);
    streamTimer = setInterval(() => {
      if (Date.now() < until) return delta(" .");
      delta(" " + ${JSON.stringify(LIFECYCLE_PROVIDER_DONE)});
      complete("completed");
    }, 200);
    return;
  }
  if (!holding) {
    delta(" " + ${JSON.stringify(LIFECYCLE_PROVIDER_DONE)});
    complete("completed");
  }
});
`;

export const lifecycleMetadataOnlyCodex = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS]\\n"); process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize" ? { userAgent: "lifecycle-metadata" }
    : message.method === "model/list" ? { data: [], nextCursor: null } : { rateLimits: null };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;

function lifecycleKimiSource(eventsPath: string): string {
  return `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("kimi 0.41.0"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") { console.log("Usage: kimi acp - Agent Client Protocol"); process.exit(0); }
if (args[0] === "provider" && args[1] === "list") { console.log(JSON.stringify({ providers: { synthetic: {} } })); process.exit(0); }
if (args.join(" ") !== "acp") throw new Error("Unexpected synthetic Kimi invocation.");
${recorder(JSON.stringify(eventsPath))}
record("started");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let sessionId = "lifecycle-kimi-session";
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "0.41.0" },
    agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
    authMethods: [],
  } });
  if (message.method === "session/new" || message.method === "session/resume") {
    if (message.params.sessionId) sessionId = message.params.sessionId;
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] }, configOptions: [],
    } });
    return send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } });
  }
  if (message.method === "session/cancel") return record("interrupt");
  if (message.method === "session/prompt") {
    record("turn");
    return send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(LIFECYCLE_PROVIDER_OUTPUT)} } },
    } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported synthetic Kimi RPC." } });
});
`;
}

export async function installLifecycleKimi(
  testDirectory: string,
  workspaceDirectory: string,
  environment: Record<string, string>,
): Promise<void> {
  const bin = join(testDirectory, "provider-bin");
  const home = join(testDirectory, "provider-home");
  await Promise.all([bin, home].map(path => mkdir(path, { recursive: true })));
  const eventsPath = join(workspaceDirectory, ".git", "lifecycle-provider.jsonl");
  await writeFile(eventsPath, "", "utf8");
  writeNodeFlagExecutable(bin, "kimi", lifecycleKimiSource(eventsPath));
  const systemPaths = process.platform === "win32"
    ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
    : ["/usr/bin", "/bin"];
  Object.assign(environment, {
    PATH: [bin, ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home, XDG_DATA_HOME: home, KIMI_CODE_HOME: home,
    NVM_BIN: "", NVM_DIR: "", KIMI_API_KEY: "", KIMI_CODE_API_KEY: "",
  });
  const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
    { recoverInterruptedRuns: false });
  try {
    const conversation = store.snapshot().conversations[0];
    if (!conversation) throw new Error("The lifecycle Kimi conversation was not seeded.");
    store.updateConversation(conversation.id, {
      providerId: "kimi", modelSelection: providerNativeModelSelection({ providerId: "kimi" }),
    });
  } finally { store.close(); }
}

export async function lifecycleProviderEvents(workspaceDirectory: string): Promise<LifecycleProviderEvent[]> {
  const source = await readFile(join(workspaceDirectory, ".git", "lifecycle-provider.jsonl"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LifecycleProviderEvent);
}

export async function lifecycleTurnProcess(workspaceDirectory: string): Promise<LifecycleProviderEvent> {
  const events = await lifecycleProviderEvents(workspaceDirectory);
  const turn = events.findLast((event) => event.event === "turn");
  if (!turn) throw new Error("The lifecycle provider did not record a turn.");
  return turn;
}

export async function declineNativeRecoverySheet(app: AppFixture): Promise<void> {
  await app.electronApp.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox.bind(dialog);
    Reflect.set(dialog, "showMessageBox", async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: unknown; cancelId?: unknown } | undefined;
      if (options?.title !== "Recover unproven macOS runtime state?") return await Reflect.apply(original, dialog, args);
      return { response: typeof options.cancelId === "number" ? options.cancelId : 1, checkboxChecked: false };
    });
  });
}
