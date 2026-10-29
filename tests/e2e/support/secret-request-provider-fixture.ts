import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SECRET_PLAN_MESSAGE =
  "The plan: untagged VMs plus the simulator. Next I need the Tailscale auth key from you. I'll build this branch's CLI while you create it.";
export const SECRET_TITLE = "Tailscale auth key for test VMs";
export const SECRET_DESCRIPTION =
  "Joins the test VMs to your tailnet. In the Tailscale admin console open Settings, then Keys, choose Generate auth key and turn on Reusable and Ephemeral.";
export const SECRET_FILE_NAME = "tailscale-authkey";
export const SECRET_SAVED_REPLY = "Tailscale is up on both VMs. The simulator can reach them through the tailnet now.";
export const SECRET_DECLINED_REPLY = "Understood. I'll keep the VMs on the local network and skip the tailnet for now.";

export interface SecretProviderEvent {
  event: "thread" | "turn" | "tool-result";
  tools?: string[];
  prompt?: string;
  callId?: string;
  success?: boolean;
  payload?: Record<string, unknown>;
}

export const secretRequestCodexAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const recordPath = path.join(process.cwd(), ".git", "secret-provider.jsonl");
const record = (entry) => fs.appendFileSync(recordPath, JSON.stringify(entry) + "\\n");
let threadId = "secret-thread";
let turnSequence = 0;
const pending = new Map();
const notify = (turn, method, params) => send({ method, params: { threadId, turnId: turn.id, ...params } });
const message = (turn, itemId, text) => {
  notify(turn, "item/agentMessage/delta", { itemId, delta: text });
  notify(turn, "item/completed", { item: { id: itemId, type: "agentMessage", text } });
};
const complete = (turn) => send({ method: "turn/completed", params: {
  threadId, turn: { id: turn.id, status: "completed", items: [], error: null },
} });
const afterSaved = (turn, file) => {
  const command = "cat '" + file + "'";
  const itemId = turn.id + "-cat";
  const value = fs.readFileSync(file, "utf8");
  const middle = Math.max(1, Math.floor(value.length / 2));
  notify(turn, "item/started", { item: { id: itemId, type: "commandExecution", command, status: "inProgress" } });
  notify(turn, "item/commandExecution/outputDelta", { itemId, delta: value.slice(0, middle) });
  notify(turn, "item/commandExecution/outputDelta", { itemId, delta: value.slice(middle) + "\\n" });
  notify(turn, "item/completed", { item: {
    id: itemId, type: "commandExecution", command, status: "completed", aggregatedOutput: value + "\\n", exitCode: 0,
  } });
  message(turn, turn.id + "-done", ${JSON.stringify(SECRET_SAVED_REPLY)});
  complete(turn);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const incoming = JSON.parse(line);
  if (incoming.method === "initialize") return send({ id: incoming.id, result: { userAgent: "secret-request-fixture" } });
  if (incoming.method === "initialized") return;
  if (incoming.method === "model/list") return send({ id: incoming.id, result: { data: [], nextCursor: null } });
  if (incoming.method === "account/rateLimits/read") {
    return send({ id: incoming.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (incoming.method === "thread/goal/get") return send({ id: incoming.id, result: { goal: null } });
  if (incoming.method === "thread/start" || incoming.method === "thread/resume") {
    threadId = (incoming.params && incoming.params.threadId) || threadId;
    record({ event: "thread", tools: ((incoming.params && incoming.params.dynamicTools) || []).map((tool) => tool.name) });
    return send({ id: incoming.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null,
    } });
  }
  if (incoming.method === "turn/interrupt") return send({ id: incoming.id, result: {} });
  if (incoming.method === "turn/start") {
    turnSequence += 1;
    const turn = { id: "secret-turn-" + turnSequence };
    const prompt = (incoming.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
    record({ event: "turn", prompt });
    const body = { id: turn.id, status: "inProgress", items: [], error: null };
    send({ id: incoming.id, result: { turn: body } });
    send({ method: "turn/started", params: { threadId, turn: body } });
    message(turn, turn.id + "-plan", ${JSON.stringify(SECRET_PLAN_MESSAGE)});
    const requestId = "secret-request-" + turnSequence;
    const callId = "secret-call-" + turnSequence;
    pending.set(requestId, { turn, callId });
    send({ id: requestId, method: "item/tool/call", params: {
      threadId, turnId: turn.id, callId, tool: "inertia_request_secret",
      arguments: {
        title: ${JSON.stringify(SECRET_TITLE)},
        description: ${JSON.stringify(SECRET_DESCRIPTION)},
        fileName: ${JSON.stringify(SECRET_FILE_NAME)},
        ttlHours: 24,
      },
    } });
    return;
  }
  if (incoming.id !== undefined && pending.has(incoming.id) && (incoming.result || incoming.error)) {
    const { turn, callId } = pending.get(incoming.id);
    pending.delete(incoming.id);
    send({ method: "serverRequest/resolved", params: { threadId, turnId: turn.id, requestId: incoming.id } });
    const result = incoming.result || {};
    const text = ((result.contentItems || [])[0] || {}).text || "{}";
    let payload = {};
    try { payload = JSON.parse(text); } catch {}
    record({ event: "tool-result", callId, success: result.success === true, payload });
    if (payload.status === "saved" && typeof payload.file === "string") return afterSaved(turn, payload.file);
    message(turn, turn.id + "-done", ${JSON.stringify(SECRET_DECLINED_REPLY)});
    complete(turn);
    return;
  }
  if (incoming.id !== undefined && incoming.method) send({ id: incoming.id, result: {} });
});
`;

export async function secretProviderEvents(workspaceDirectory: string): Promise<SecretProviderEvent[]> {
  const source = await readFile(join(workspaceDirectory, ".git", "secret-provider.jsonl"), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  return source.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SecretProviderEvent);
}
