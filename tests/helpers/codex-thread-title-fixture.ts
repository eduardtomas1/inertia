import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  portableFixtureRoot,
  portableNodeExecutable,
  writeNodeSubcommand,
} from "./portable-provider-fixture";

export type CodexThreadTitleScenario =
  | "success"
  | "error"
  | "approval"
  | "hang"
  | "slow-start"
  | "deaf"
  | "overflow"
  | "persistent-thread"
  | "writable-thread";

export interface CodexThreadTitleFixture {
  root: string;
  command: string;
  capturePath: string;
  pidsPath: string;
  environment(scenario: CodexThreadTitleScenario, response?: string): NodeJS.ProcessEnv;
}

export function fakeThreadTitleAppServer(roots: string[]): CodexThreadTitleFixture {
  const root = portableFixtureRoot("codex title");
  roots.push(root);
  const command = portableNodeExecutable(root, "codex");
  const capturePath = join(root, "capture.jsonl");
  const pidsPath = join(root, "pids.json");
  writeNodeSubcommand(root, "app-server", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const scenario = process.env.INERTIA_TITLE_SCENARIO;
const response = process.env.INERTIA_TITLE_RESPONSE;
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.INERTIA_TITLE_PIDS, JSON.stringify({ server: process.pid, descendant: descendant.pid }));
const capture = (value) => fs.appendFileSync(process.env.INERTIA_TITLE_CAPTURE, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "title-thread";
const turnId = "title-turn";
const turn = (status) => ({
  id: turnId,
  items: [],
  status,
  error: status === "failed" ? { message: "model unavailable", codexErrorInfo: null, additionalDetails: null } : null,
});
const agentMessage = (thread, turnIdentifier, id, text) => send({
  method: "item/completed",
  params: { threadId: thread, turnId: turnIdentifier, completedAtMs: Date.now(), item: { type: "agentMessage", id, text, phase: "final_answer" } },
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "config/read") {
    return send({ id: message.id, result: { config: { model: "fake", mcp_servers: { docs: { command: "docs-server" }, search: { url: "http://127.0.0.1:9" } } } } });
  }
  if (message.method === "thread/start") {
    const readOnly = scenario !== "writable-thread" && message.params.sandbox === "read-only";
    return send({ id: message.id, result: {
      thread: { id: threadId, ephemeral: scenario !== "persistent-thread" && message.params.ephemeral === true },
      model: message.params.model,
      modelProvider: "openai",
      serviceTier: null,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: readOnly ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      reasoningEffort: null,
    } });
  }
  if (message.method === "turn/start" && scenario === "slow-start") {
    return setTimeout(() => send({ id: message.id, result: { turn: turn("inProgress") } }), 500);
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId, turn: turn("inProgress") } });
    agentMessage("other-thread", "other-turn", "other-message", JSON.stringify({ title: "Unrelated thread" }));
    agentMessage(threadId, "other-turn", "stale-message", JSON.stringify({ title: "Stale turn" }));
    if (scenario === "hang" || scenario === "deaf") return;
    if (scenario === "approval") {
      return send({ id: "approval-rpc", method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "command-1", command: "touch escaped", cwd: process.cwd() } });
    }
    if (scenario === "error") {
      send({ method: "error", params: { threadId, turnId, willRetry: true, error: { message: "retrying" } } });
      send({ method: "error", params: { threadId, turnId, willRetry: false, error: { message: "model unavailable" } } });
      return send({ method: "turn/completed", params: { threadId, turn: turn("failed") } });
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: response } });
    agentMessage(threadId, turnId, "message-1", response);
    if (scenario === "overflow") return;
    return send({ method: "turn/completed", params: { threadId, turn: turn("completed") } });
  }
  if (message.method === "turn/interrupt") {
    if (scenario === "deaf") return;
    send({ id: message.id, result: {} });
    return send({ method: "turn/completed", params: { threadId, turn: turn("interrupted") } });
  }
  if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "unsupported by the title fixture" } });
  }
});
`);
  return {
    root,
    command,
    capturePath,
    pidsPath,
    environment: (scenario, response = JSON.stringify({ title: "Login redirect loop" })) => ({
      ...process.env,
      INERTIA_TITLE_SCENARIO: scenario,
      INERTIA_TITLE_RESPONSE: response,
      INERTIA_TITLE_CAPTURE: capturePath,
      INERTIA_TITLE_PIDS: pidsPath,
    }),
  };
}

export function titleFixturePids(path: string): { server: number; descendant: number } {
  return JSON.parse(readFileSync(path, "utf8")) as { server: number; descendant: number };
}
