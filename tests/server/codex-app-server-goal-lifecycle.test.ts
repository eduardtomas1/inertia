import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

describe.sequential("Codex App Server goal lifecycle", () => {
  const roots: string[] = [];
  const originalCapture = process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE;
  const originalScenario = process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO;

  afterEach(async () => {
    if (originalCapture === undefined) {
      delete process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE;
    } else {
      process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE = originalCapture;
    }
    if (originalScenario === undefined) {
      delete process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO;
    } else {
      process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO = originalScenario;
    }
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fixture(): { root: string; command: string; capturePath: string } {
    const root = portableFixtureRoot("goal lifecycle");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const capture = (message) => fs.appendFileSync(
  process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE,
  JSON.stringify(message) + "\\n",
);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const scenario = process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO;
let threadId = "thread-goal-lifecycle";
let turnId = "turn-goal-lifecycle";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") {
    const reply = () => send({ id: message.id, result: { userAgent: "fixture" } });
    if (scenario === "startup-gate") return setTimeout(reply, 20);
    reply();
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/goal/set") {
    const goal = {
      threadId,
      objective: message.params.objective || "Existing goal",
      status: message.params.status,
      tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1800000000,
      updatedAt: 1800000000,
    };
    send({ id: message.id, result: { goal } });
    send({ method: "thread/goal/updated", params: { threadId, goal } });
    return;
  }
  if (message.method === "thread/goal/clear") {
    send({ id: message.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    if (scenario === "no-continuation") {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message", delta: "Resumed goal turn. " } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
  }
});
`);
    return { root, command, capturePath };
  }

  function methods(capturePath: string): string[] {
    return readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: unknown })
      .flatMap(({ method }) => typeof method === "string" ? [method] : []);
  }

  it("fails when the provider never starts the first goal turn", async () => {
    const fake = fixture();
    process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE = fake.capturePath;
    process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO = "no-first-turn";
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "/goal Wait for the provider-owned turn",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-lifecycle",
      goalStart: { objective: "Wait for the provider-owned turn" },
      goalContinuationExpected: true,
      goalContinuationGraceMs: 25,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "goal-continuation-timeout" },
    });
    expect(methods(fake.capturePath)).not.toContain("turn/start");
  });

  it("fails when an active goal does not continue", async () => {
    const fake = fixture();
    process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE = fake.capturePath;
    process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO = "no-continuation";
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Continue the saved goal",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-lifecycle",
      goalContinuationExpected: true,
      goalContinuationGraceMs: 25,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      text: "Resumed goal turn. ",
      failure: { reason: "goal-continuation-timeout" },
    });
  });

  it("serializes mutations behind initialization and ordinary turn start", async () => {
    const fake = fixture();
    process.env.INERTIA_GOAL_LIFECYCLE_CAPTURE = fake.capturePath;
    process.env.INERTIA_GOAL_LIFECYCLE_SCENARIO = "startup-gate";
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Start while goal controls race startup",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-lifecycle",
    });

    const update = run.setGoal({ status: "paused" });
    const clear = run.clearGoal();
    await expect(update).resolves.toMatchObject({ status: "paused" });
    await expect(clear).resolves.toBe(true);
    const capturedMethods = methods(fake.capturePath);
    expect(capturedMethods.indexOf("thread/goal/set"))
      .toBeGreaterThan(capturedMethods.indexOf("turn/start"));
    expect(capturedMethods.indexOf("thread/goal/clear"))
      .toBeGreaterThan(capturedMethods.indexOf("thread/goal/set"));

    run.cancel(true);
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
  });
});
