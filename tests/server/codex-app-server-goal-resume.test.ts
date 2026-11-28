// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import type { ProviderHistoryInjection } from "../../src/server/provider/contracts";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

type Scenario =
  | "orphan-before-response" | "steered" | "never-stops" | "orphan-approval"
  | "finished-before-start" | "goal-start" | "goal-start-approval" | "quiet"
  | "orphan-after-response" | "orphan-2ms-after-response" | "pause-fails" | "interrupt-errors" | "slow-pause"
  | "finished-before-start-approval";

const STOPPED = "info:Stopped the turn Codex continued the goal with on resume";
const FINISHED = "info:Codex continued the goal on resume; that turn ended before this run's turn and is not shown";
const PAUSED = "info:Paused the goal Codex continued on resume";
const PAUSE_FAILED = "info:Could not pause the goal Codex continued on resume; it stays active";

// Codex continues an active goal right after thread/resume, before the run's
// own turn/start (T3 47583f868), and steers a turn/start on a busy thread
// into the running turn. This fake App Server does both and records every
// message it receives.
function fakeAppServer(scenario: Scenario) {
  const root = portableFixtureRoot("codex goal resume");
  const command = portableNodeExecutable(root, "codex");
  const capturePath = join(root, "capture.jsonl");
  writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const scenario = ${JSON.stringify(scenario)};
const approval = ["orphan-approval", "goal-start-approval", "finished-before-start-approval"].includes(scenario);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const threadId = "thread-goal";
let goalStatus = "active";
let updatedAt = 1800000001;
let goalTurnRunning = false;
let approved = false;
let goalSet = false;
let pausedGoal = false;
let userTurnPending = false;
const goal = () => ({ threadId, objective: "Ship the release", status: goalStatus, tokenBudget: null,
  tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1800000000, updatedAt });
const setGoal = (status) => { goalStatus = status; updatedAt += 1; send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: goal() } }); };
const turn = (id, status) => ({ id, status, items: [], error: null });
const delta = (turnId, text) => send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: turnId + "-message", delta: text } });
const finishUserTurn = () => {
  if (!userTurnPending) return;
  if (scenario === "finished-before-start" && !pausedGoal) return;
  if (scenario === "finished-before-start-approval" && (!approved || !pausedGoal)) return;
  userTurnPending = false;
  if (goalStatus === "active") setGoal("complete");
  send({ method: "turn/completed", params: { threadId, turn: turn("user-turn", "completed") } });
};
const continueGoal = () => {
  goalTurnRunning = true;
  send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: goal() } });
  send({ method: "turn/started", params: { threadId, turn: turn("goal-turn", "inProgress") } });
  delta("goal-turn", "Goal work. ");
  if (approval) send({ id: "goal-approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId: "goal-turn",
    itemId: "goal-command", startedAtMs: 1800000000000, environmentId: null, command: "npm test", cwd: process.cwd(),
    commandActions: [], availableDecisions: ["accept", "cancel"] } });
};
const finishGoalTurn = (status) => {
  goalTurnRunning = false;
  if (status === "completed") setGoal("complete");
  send({ method: "turn/completed", params: { threadId, turn: turn("goal-turn", status) } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capturePath)}, line + "\\n");
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "thread/resume") {
    const late = ["steered", "finished-before-start", "finished-before-start-approval", "quiet",
      "orphan-after-response", "orphan-2ms-after-response"];
    if (!late.includes(scenario)) continueGoal();
    send({ id: message.id, result: { thread: { id: threadId } } });
    if (scenario === "orphan-after-response") continueGoal();
    // As T3 notes (CodexAdapterV2 ~8143), Codex continues the goal after the response, in a later write.
    if (scenario === "orphan-2ms-after-response") setTimeout(continueGoal, 2);
    return;
  }
  if (message.method === "thread/goal/set" && scenario === "pause-fails" && message.params.status === "paused") {
    return send({ id: message.id, error: { code: -32603, message: "goal store busy" } });
  }
  if (message.method === "thread/goal/set" && scenario === "slow-pause" && message.params.status === "paused") {
    const id = message.id;
    setTimeout(() => { goalStatus = "paused"; updatedAt += 1; send({ id, result: { goal: goal() } }); }, 250);
    return;
  }
  if (message.method === "thread/goal/set") {
    goalStatus = message.params.status;
    if (goalStatus === "paused") pausedGoal = true;
    updatedAt += 1;
    send({ id: message.id, result: { goal: goal() } });
    send({ method: "thread/goal/updated", params: { threadId, turnId: null, goal: goal() } });
    if (goalStatus === "active" && goalTurnRunning) {
      goalSet = true;
      delta("goal-turn", "Goal reply.");
      if (!approval || approved) finishGoalTurn("completed");
    }
    finishUserTurn();
    return;
  }
  if (message.id === "goal-approval") {
    approved = true;
    if (scenario === "goal-start-approval" && goalSet) finishGoalTurn("completed");
    finishUserTurn();
    return;
  }
  if (message.method === "turn/interrupt") {
    if (scenario === "interrupt-errors") {
      // The turn is already finishing: Codex has no active turn to interrupt, and completes it shortly.
      send({ id: message.id, error: { code: -32600, message: "no active turn to interrupt" } });
      setTimeout(() => finishGoalTurn("interrupted"), 20);
      return;
    }
    send({ id: message.id, result: {} });
    if (scenario === "slow-pause") setTimeout(() => finishGoalTurn("interrupted"), 100);
    else if (scenario !== "never-stops") finishGoalTurn("interrupted");
    return;
  }
  if (message.method === "turn/start") {
    // Codex continues the goal just before it takes the run's turn/start.
    const finishedBefore = scenario === "finished-before-start" || scenario === "finished-before-start-approval";
    if (scenario === "steered" || finishedBefore) continueGoal();
    if (finishedBefore) finishGoalTurn("interrupted");
    const id = goalTurnRunning ? "goal-turn" : "user-turn";
    send({ id: message.id, result: { turn: turn(id, "inProgress") } });
    if (id === "user-turn") send({ method: "turn/started", params: { threadId, turn: turn(id, "inProgress") } });
    delta(id, "Reply to the user.");
    if (finishedBefore) {
      userTurnPending = true;
      finishUserTurn();
      return;
    }
    if (goalStatus === "active") setGoal("complete");
    send({ method: "turn/completed", params: { threadId, turn: turn(id, "completed") } });
    return;
  }
  if (message.id !== undefined && message.method !== undefined) send({ id: message.id, result: {} });
});
`);
  const messages = () => readFileSync(capturePath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown });
  const requests = () => messages().filter(({ method }) => method !== undefined);
  return { root, command, messages, requests };
}

describe("Codex goal turn continued on resume", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

  function run(scenario: Scenario, historyInjection?: ProviderHistoryInjection) {
    const fake = fakeAppServer(scenario);
    roots.push(fake.root);
    const activities: string[] = [];
    const goals: string[] = [];
    const approvals: string[] = [];
    const text: string[] = [];
    const goalStart = scenario.startsWith("goal-start");
    const started = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: goalStart ? "/goal Ship the release" : "Check the release notes",
      planMode: false,
      access: "supervised",
      sessionId: "thread-goal",
      goalContinuationExpected: true,
      goalContinuationGraceMs: 50,
      rpcTimeoutMs: scenario === "never-stops" ? 200 : scenario === "slow-pause" ? 300 : undefined,
      ...(goalStart ? { goalStart: { objective: "Ship the release" } } : {}),
      ...(historyInjection ? { historyInjection } : {}),
      onText: (delta) => text.push(delta),
      onActivity: (_kind, phase, label) => activities.push(`${phase}:${label}`),
      onGoalUpdated: (_threadId, goal) => goals.push(goal.status),
      onApproval: (request) => {
        approvals.push(request.command ?? request.title);
        void started.respondToApproval(request.requestId, "approve");
      },
    });
    return { fake, result: started.result, activities, goals, approvals, text };
  }

  it("pauses the goal and stops the turn Codex continued it with on resume before sending the run's turn (T3 47583f868)",
    async () => {
      const { fake, result, activities, goals, text } = run("orphan-before-response");

      await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
      const requests = fake.requests();
      expect(requests.map(({ method }) => method)).toEqual([
        "initialize", "initialized", "thread/resume", "thread/goal/set", "turn/interrupt", "turn/start",
      ]);
      expect(requests[3]!.params).toEqual({ threadId: "thread-goal", status: "paused" });
      expect(requests[4]!.params).toEqual({ threadId: "thread-goal", turnId: "goal-turn" });
      expect(activities).toContain(STOPPED);
      await expect.poll(() => activities).toContain(PAUSED);
      expect(activities.filter((activity) => activity === "started:Turn started")).toHaveLength(1);
      expect(text.join("")).toBe("Reply to the user.");
      expect(goals).toContain("paused");
    });

  it("owns a goal turn Codex started only once it had the run's turn/start, which it steered into that turn", async () => {
    // As in T3, a goal turn that starts after the run's turn/start went out cannot be told from the run's own turn.
    const { fake, result, activities, text } = run("steered");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Goal work. Reply to the user." });
    expect(fake.requests().map(({ method }) => method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(activities).not.toContain(STOPPED);
    expect(text.join("")).toBe("Goal work. Reply to the user.");
  });

  it("fails without sending the prompt when Codex does not stop that turn", async () => {
    const { fake, result, text } = run("never-stops");

    await expect(result).resolves.toMatchObject({
      status: "failed",
      failure: { technicalDetail: expect.stringContaining("Codex did not stop the goal turn it continued when the thread resumed.") },
    });
    expect(fake.requests().map(({ method }) => method)).not.toContain("turn/start");
    expect(text).toEqual([]);
  });

  it("cancels an approval that stopped goal turn asks for instead of asking the user", async () => {
    const { fake, result, approvals } = run("orphan-approval");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
    expect(approvals).toEqual([]);
    expect(fake.messages().find(({ id, method }) => id === "goal-approval" && method === undefined))
      .toMatchObject({ result: { decision: "cancel" } });
  });

  it("pauses the goal and notes a goal turn that ended before turn/start was answered instead of discarding it silently", async () => {
    const { fake, result, activities, goals, text } = run("finished-before-start");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
    const methods = fake.requests().map(({ method }) => method);
    expect(methods).toEqual(["initialize", "initialized", "thread/resume", "turn/start", "thread/goal/set"]);
    expect(fake.requests()[4]!.params).toEqual({ threadId: "thread-goal", status: "paused" });
    expect(goals).toContain("paused");
    expect(methods).not.toContain("turn/interrupt");
    expect(activities).toContain(FINISHED);
    expect(text.join("")).toBe("Reply to the user.");
  });

  it("lets an explicit goal start own the goal turn Codex continued while the thread resumed", async () => {
    const { fake, result, activities, text } = run("goal-start");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Goal work. Goal reply." });
    expect(fake.requests().map(({ method }) => method)).toEqual([
      "initialize", "initialized", "thread/resume", "thread/goal/set",
    ]);
    expect(fake.requests()[3]!.params).toMatchObject({ status: "active", objective: "Ship the release" });
    expect(activities).toEqual(expect.arrayContaining(["started:Turn started", "completed:Turn completed"]));
    expect(activities).not.toContain(STOPPED);
    expect(text.join("")).toBe("Goal work. Goal reply.");
  });

  it("asks the user about an approval that goal turn requested while the thread resumed, in a goal start", async () => {
    const { fake, result, approvals } = run("goal-start-approval");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Goal work. Goal reply." });
    expect(approvals).toEqual(["npm test"]);
    expect(fake.messages().find(({ id, method }) => id === "goal-approval" && method === undefined))
      .toMatchObject({ result: { decision: "accept" } });
  });

  it("sends restored history inline, not injected, on a resumed thread Codex may continue a goal in", async () => {
    const steps: string[] = [];
    const injection: ProviderHistoryInjection = {
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Earlier request" }] }],
      prompt: "Native prompt",
      begin: () => { steps.push("begin"); return true; },
      delivered: () => { steps.push("delivered"); return true; },
      unsupported: () => { steps.push("unsupported"); return true; },
    };
    const { fake, result } = run("quiet", injection);

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(steps).toEqual([]);
    const requests = fake.requests();
    expect(requests.map(({ method }) => method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    const turnStart = requests.find(({ method }) => method === "turn/start")!;
    expect((turnStart.params!.input as Array<{ text?: string }>)[0]!.text).toBe("Check the release notes");
  });

  it.each(["orphan-after-response", "orphan-2ms-after-response"] as const)(
    "gives Codex a short grace to continue the goal after the resume response (%s), then stops that turn before the run's",
    async (scenario) => {
      const { fake, result, activities, text } = run(scenario);

      await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
      expect(fake.requests().map(({ method }) => method)).toEqual([
        "initialize", "initialized", "thread/resume", "thread/goal/set", "turn/interrupt", "turn/start",
      ]);
      expect(activities).toContain(STOPPED);
      expect(text.join("")).toBe("Reply to the user.");
    },
  );

  it("says the goal stays active when Codex refuses to pause it, and still stops the turn", async () => {
    const { fake, result, activities, goals } = run("pause-fails");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
    expect(fake.requests().map(({ method }) => method)).toEqual([
      "initialize", "initialized", "thread/resume", "thread/goal/set", "turn/interrupt", "turn/start",
    ]);
    expect(activities).toEqual(expect.arrayContaining([STOPPED, PAUSE_FAILED]));
    expect(activities).not.toContain(PAUSED);
    expect(goals).not.toContain("paused");
  });

  it("keeps waiting for the stopped turn to complete when Codex answers that it has no active turn", async () => {
    const { result } = run("interrupt-errors");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
  });

  it("interrupts without waiting for a slow pause response, in T3's pause-then-interrupt order", async () => {
    const { fake, result } = run("slow-pause");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
    expect(fake.requests().map(({ method }) => method).slice(3, 5)).toEqual(["thread/goal/set", "turn/interrupt"]);
  });

  it("cancels an approval held for a goal turn that turn/start's response showed was not the run's", async () => {
    const { fake, result, approvals } = run("finished-before-start-approval");

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Reply to the user." });
    expect(approvals).toEqual([]);
    expect(fake.messages().find(({ id, method }) => id === "goal-approval" && method === undefined))
      .toMatchObject({ result: { decision: "cancel" } });
  });
});
