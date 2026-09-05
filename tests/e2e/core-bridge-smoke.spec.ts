import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";
import { attachRuntimeLifecycleFailureDiagnostic } from "./support/runtime-lifecycle-diagnostics";

const providerOutput = "Electron/core bridge provider output is live.";
const interruptMarker = "core-bridge-interrupt-accepted";

const coreBridgeAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "core-bridge-thread";
let activeTurnId = null;
let turnSequence = 0;
let settled = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "core-bridge-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: "fixture",
      serviceTier: null, initialTurnsPage: null,
    } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    fs.writeFileSync(path.join(process.cwd(), ".git", "${interruptMarker}"), "accepted\\n");
    if (!activeTurnId || settled) return;
    settled = true;
    setTimeout(() => send({ method: "turn/completed", params: {
      threadId,
      turn: {
        id: activeTurnId,
        status: "interrupted",
        items: [],
        error: null,
      },
    } }), 350);
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  activeTurnId = "core-bridge-turn-" + turnSequence;
  settled = false;
  send({ id: message.id, result: {
    turn: { id: activeTurnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "turn/started", params: {
    threadId,
    turn: { id: activeTurnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "item/agentMessage/delta", params: {
    threadId,
    turnId: activeTurnId,
    itemId: "core-bridge-answer",
    delta: ${JSON.stringify(providerOutput)},
  } });
});
`;

interface DurableTurnState {
  conversationPresent: boolean;
  status: string | null;
  terminalReason: string | null;
  providerOwnerCount: number;
}

function durableTurnState(
  databasePath: string,
  conversationId: string,
  turnId: string,
): DurableTurnState {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const turn = database.prepare(`
      SELECT status, terminal_reason AS terminalReason
      FROM agent_turns
      WHERE id = ? AND conversation_id = ?
    `).get(turnId, conversationId) as {
      status: string;
      terminalReason: string | null;
    } | undefined;
    const ownership = database.prepare(`
      SELECT COUNT(*) AS count
      FROM provider_run_ownership
      WHERE turn_id = ? AND conversation_id = ?
    `).get(turnId, conversationId) as { count: number };
    const conversation = database.prepare(
      "SELECT 1 FROM conversations WHERE id = ?",
    ).get(conversationId);
    return {
      conversationPresent: conversation !== undefined,
      status: turn?.status ?? null,
      terminalReason: turn?.terminalReason ?? null,
      providerOwnerCount: ownership.count,
    };
  } finally {
    database.close();
  }
}

test("keeps one cancelled provider turn authoritative across the Electron/core bridge", async () => {
  test.setTimeout(75_000);
  let conversationId = "";
  const app = await createAppFixture({
    name: "core-bridge-smoke",
    initialState: "conversation",
    codexAppServerSource: coreBridgeAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      conversationId = store.shellSnapshot().activeConversationId ?? "";
      store.close();
      if (!conversationId) throw new Error("Core bridge fixture has no conversation.");
    },
  });

  try {
    const initialRuntime = await app.runtimeSnapshot();
    expect(initialRuntime).toMatchObject({ phase: "ready" });
    expect(initialRuntime.pid).toBeGreaterThan(0);

    const request = "Run the compact Electron/core bridge smoke.";
    const composer = app.page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const turn = app.page.locator("[data-turn-id]").filter({
      has: app.page.getByText(request, { exact: true }),
    });
    await expect(turn).toBeVisible();
    await expect(app.page.getByText(providerOutput, { exact: true }))
      .toBeVisible({ timeout: 20_000 });
    const turnId = await turn.getAttribute("data-turn-id");
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/iu);

    await composer.getByRole("button", { name: "Stop agent" }).click();
    await expect.poll(async () => await readFile(
      join(app.workspaceDirectory, ".git", interruptMarker),
      "utf8",
    ).catch(() => "")).toBe("accepted\n");
    await expect.poll(() => durableTurnState(
      join(app.testDirectory, "data", "inertia.sqlite"),
      conversationId,
      turnId!,
    )).toEqual({
      conversationPresent: true,
      status: "cancelled",
      terminalReason: "user-cancelled",
      providerOwnerCount: 0,
    });
    await expect(turn.locator('[data-turn-status="cancelled"]')).toBeVisible();

    await app.recycleRuntime();
    await expect.poll(async () => {
      const snapshot = await app.runtimeSnapshot();
      return snapshot.phase === "ready"
        && snapshot.generation > initialRuntime.generation;
    }, { timeout: 20_000 }).toBe(true);
    await app.page.reload();
    await expect(app.page.locator(".app-shell")).toHaveAttribute(
      "data-connection-status",
      "online",
    );
    await expect(app.page.getByRole("heading", {
      name: "core-bridge-smoke fixture",
      level: 1,
    })).toBeVisible();
    await expect(turn.locator('[data-request-content="complete"]'))
      .toHaveText(request);
    await expect(app.page.getByText(providerOutput, { exact: true })).toBeVisible();
    expect(durableTurnState(
      join(app.testDirectory, "data", "inertia.sqlite"),
      conversationId,
      turnId!,
    )).toEqual({
      conversationPresent: true,
      status: "cancelled",
      terminalReason: "user-cancelled",
      providerOwnerCount: 0,
    });
    expect(app.rendererErrors).toEqual([]);
  } finally {
    // The fixture rejects unless Electron, the runtime, provider ownership,
    // transport, preview server, and private temporary directory all close.
    // Observe concurrently: awaiting a diagnostic first could let an active
    // Git refresh finish and hide the immediate-shutdown race under test.
    const diagnostic = process.platform === "win32"
      ? attachRuntimeLifecycleFailureDiagnostic(test.info(), async () =>
        (await app.runtimeSnapshot()).websocketUrl).catch(() => undefined)
      : Promise.resolve();
    try {
      await app.close();
    } finally {
      await diagnostic;
    }
  }
});
