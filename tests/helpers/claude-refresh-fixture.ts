import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeNodeClaudeExecutable, writeNodeFlagExecutable } from "./portable-provider-fixture";

export interface ClaudeRefreshDelays {
  startupMs: number;
  versionMs: number;
  authMs: number;
  initializeMs: number;
  usageMs: number;
  exitMs: number;
}

export interface ClaudeRefreshFixturePlan extends ClaudeRefreshDelays {
  signedOut?: boolean;
  malformedAuth?: boolean;
  slowCalls?: Partial<Record<ClaudeRefreshCallKind, number>>;
  slowExtraMs?: number;
}

export type ClaudeRefreshCallKind = "version" | "auth" | "sdk";

export interface ClaudeRefreshCall {
  pid: number;
  kind: ClaudeRefreshCallKind;
  startedAt: number;
  endedAt: number | null;
  requests: string[];
}

export const CLAUDE_REFRESH_BASE_DELAYS: ClaudeRefreshDelays = {
  startupMs: 150,
  versionMs: 0,
  authMs: 400,
  initializeMs: 1_000,
  usageMs: 500,
  exitMs: 150,
};

export const CURSOR_REFRESH_BASE_DELAYS = {
  startupMs: 300,
  statusMs: 800,
};

export function scaledClaudeRefreshDelays(scale: number): ClaudeRefreshDelays {
  return Object.fromEntries(
    Object.entries(CLAUDE_REFRESH_BASE_DELAYS).map(([key, value]) => [key, value * scale]),
  ) as unknown as ClaudeRefreshDelays;
}

export interface ClaudeRefreshFixture {
  executable: string;
  setPlan(plan: ClaudeRefreshFixturePlan): void;
  calls(): ClaudeRefreshCall[];
  resetCalls(): void;
}

export function writeClaudeRefreshFixture(root: string): ClaudeRefreshFixture {
  const planPath = join(root, "claude-plan.json");
  const logPath = join(root, "claude-calls.log");
  writeFileSync(planPath, JSON.stringify(CLAUDE_REFRESH_BASE_DELAYS));
  writeFileSync(logPath, "");
  const executable = writeNodeClaudeExecutable(root, `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const kind = args[0] === "--version" ? "version"
  : args[0] === "auth" && args[1] === "status" ? "auth"
  : "sdk";
const planPath = ${JSON.stringify(planPath)};
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
let slow = 0;
if ((plan.slowCalls?.[kind] ?? 0) > 0) {
  plan.slowCalls[kind] -= 1;
  fs.writeFileSync(planPath, JSON.stringify(plan));
  slow = plan.slowExtraMs ?? 0;
}
const requests = [];
const log = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  pid: process.pid, kind, event, at: Date.now(), requests,
}) + "\\n");
log("start");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finish = (code) => { log("end"); process.exitCode = code; };
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
(async () => {
  await wait(plan.startupMs + slow);
  if (kind === "version") {
    await wait(plan.versionMs);
    process.stdout.write("2.1.320 (Claude Code)\\n");
    finish(0);
    return;
  }
  if (kind === "auth") {
    await wait(plan.authMs);
    if (plan.malformedAuth) {
      process.stdout.write("{not json\\n");
      finish(0);
      return;
    }
    process.stdout.write(JSON.stringify(plan.signedOut
      ? { loggedIn: false }
      : { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\\n");
    finish(plan.signedOut ? 1 : 0);
    return;
  }
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type !== "control_request") return;
    requests.push(message.request.subtype);
    if (message.request.subtype === "initialize") {
      await wait(plan.initializeMs);
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: { commands: [], models: [
          { value: "fixture-opus", displayName: "Fixture Opus", description: "Fixture model", supportedEffortLevels: ["low", "high"] },
          { value: "fixture-sonnet", displayName: "Fixture Sonnet", description: "Fixture model" },
        ], account: { email: "fixture@example.invalid", subscriptionType: "max", apiProvider: "firstParty" } } } });
    } else if (message.request.subtype === "get_usage") {
      await wait(plan.usageMs);
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: { rate_limits_available: true, rate_limits: {
          five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00.000Z" },
        } } } });
    } else {
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "unsupported" } });
    }
  });
  input.on("close", async () => {
    await wait(plan.exitMs);
    finish(0);
  });
})();
`);
  return {
    executable,
    setPlan: (plan) => writeFileSync(planPath, JSON.stringify(plan)),
    calls: () => {
      const calls = new Map<number, ClaudeRefreshCall>();
      for (const line of readFileSync(logPath, "utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as {
          pid: number; kind: ClaudeRefreshCallKind; event: "start" | "end"; at: number; requests: string[];
        };
        const call = calls.get(entry.pid)
          ?? { pid: entry.pid, kind: entry.kind, startedAt: entry.at, endedAt: null, requests: [] };
        if (entry.event === "end") call.endedAt = entry.at;
        call.requests = entry.requests;
        calls.set(entry.pid, call);
      }
      return [...calls.values()].sort((left, right) => left.startedAt - right.startedAt);
    },
    resetCalls: () => writeFileSync(logPath, ""),
  };
}

export interface CursorRefreshFixture {
  executable: string;
  setScale(scale: number): void;
}

export function writeCursorRefreshFixture(root: string): CursorRefreshFixture {
  const planPath = join(root, "cursor-plan.json");
  writeFileSync(planPath, JSON.stringify(CURSOR_REFRESH_BASE_DELAYS));
  const executable = writeNodeFlagExecutable(root, "cursor-agent", `
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}, "utf8"));
const args = process.argv.slice(2);
setTimeout(() => {
  if (args[0] === "--version") {
    process.stdout.write("cursor-agent 2026.09.01\\n");
  } else if (args[0] === "acp" && args[1] === "--help") {
    process.stdout.write("cursor-agent acp: Agent Client Protocol server\\n");
  } else if (args[0] === "status") {
    setTimeout(() => process.stdout.write("Logged in as fixture@example.invalid\\n"), plan.statusMs);
  } else {
    process.exitCode = 2;
  }
}, plan.startupMs);
`);
  return {
    executable,
    setScale: (scale) => writeFileSync(planPath, JSON.stringify({
      startupMs: CURSOR_REFRESH_BASE_DELAYS.startupMs * scale,
      statusMs: CURSOR_REFRESH_BASE_DELAYS.statusMs * scale,
    })),
  };
}
