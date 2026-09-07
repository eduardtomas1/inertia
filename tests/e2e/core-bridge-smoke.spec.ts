// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
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
const complete = () => {
  if (settled || !activeTurnId) return;
  settled = true;
  send({ method: "turn/completed", params: {
    threadId,
    turn: { id: activeTurnId, status: "completed", items: [], error: null },
  } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "core-bridge-approval" && message.result) {
    fs.writeFileSync(path.join(process.cwd(), "core-bridge-approval.json"), JSON.stringify(message.result));
    complete();
    return;
  }
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
  const prompt = (message.params.input || []).filter((item) => item.type === "text")
    .map((item) => item.text).join("\\n");
  if (prompt.includes("core:approval")) {
    send({ id: "core-bridge-approval", method: "item/commandExecution/requestApproval", params: {
      threadId, turnId: activeTurnId, itemId: "core-bridge-command",
      startedAtMs: Date.now(), command: "fixture-read-only-check", cwd: process.cwd(),
      reason: "Verify the exact Electron approval route", availableDecisions: ["accept", "decline", "cancel"],
    } });
  } else if (prompt.includes("core:complete")) complete();
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

async function sendCompletedTurn(app: AppFixture, conversationId: string, request: string): Promise<string> {
  const composer = app.page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill(request);
  await composer.getByRole("button", { name: "Send message" }).click();
  const turn = app.page.locator("[data-turn-id]").filter({
    has: app.page.getByText(request, { exact: true }),
  });
  await expect(turn).toBeVisible();
  const turnId = await turn.getAttribute("data-turn-id");
  expect(turnId).toMatch(/^[0-9a-f-]{36}$/iu);
  await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible();
  await expect(turn.getByText(providerOutput, { exact: true })).toBeVisible();
  await expect.poll(() => durableTurnState(
    join(app.testDirectory, "data", "inertia.sqlite"), conversationId, turnId!,
  )).toEqual({
    conversationPresent: true, status: "completed", terminalReason: "provider-completed", providerOwnerCount: 0,
  });
  return turnId!;
}

for (const workspaceGit of [true, false]) {
  test(`completes first and second sends and preserves history after restart in an existing ${workspaceGit ? "Git" : "non-Git"} workspace`, async () => {
    let conversationId = "";
    const app = await createAppFixture({
      name: `core-complete-${workspaceGit ? "git" : "folder"}`,
      initialState: "conversation",
      workspaceGit,
      codexAppServerSource: coreBridgeAppServer,
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
          { recoverInterruptedRuns: false });
        try {
          conversationId = store.shellSnapshot().activeConversationId!;
          store.createMessage(conversationId, "Existing synthetic history survives.", "assistant", []);
        } finally { store.close(); }
      },
    });
    try {
      const first = await sendCompletedTurn(app, conversationId, "core:complete first message");
      const second = await sendCompletedTurn(app, conversationId, "core:complete second message");
      expect(second).not.toBe(first);
      await app.restart();
      for (const turnId of [first, second]) {
        await expect(app.page.locator(`[data-turn-id="${turnId}"] [data-turn-status="completed"]`)).toBeVisible();
        expect(durableTurnState(join(app.testDirectory, "data", "inertia.sqlite"), conversationId, turnId))
          .toMatchObject({ status: "completed", providerOwnerCount: 0 });
      }
      const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND content = ?")
          .get(conversationId, "Existing synthetic history survives.")).toEqual({ count: 1 });
      } finally { database.close(); }
      await sendCompletedTurn(app, conversationId, "core:complete after restart");
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
}

for (const decision of ["approve", "deny"] as const) {
  test(`routes ${decision} through the real provider transport and admits the next send`, async () => {
    let conversationId = "";
    const app = await createAppFixture({
      name: `core-approval-${decision}`, initialState: "conversation", codexAppServerSource: coreBridgeAppServer,
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
          { recoverInterruptedRuns: false });
        try {
          conversationId = store.shellSnapshot().activeConversationId!;
          store.updateConversation(conversationId, { accessMode: "supervised" });
        } finally { store.close(); }
      },
    });
    try {
      const composer = app.page.getByRole("region", { name: "Message composer" });
      await composer.getByRole("textbox", { name: "Message" }).fill("core:approval synthetic check");
      await composer.getByRole("button", { name: "Send message" }).click();
      await app.page.getByRole("button", { name: decision === "approve" ? "Approve once" : "Deny", exact: true }).click();
      await expect.poll(async () => JSON.parse(await readFile(join(app.workspaceDirectory, "core-bridge-approval.json"), "utf8")
        .catch(() => "null"))).toEqual({ decision: decision === "approve" ? "accept" : "decline" });
      await expect(app.page.locator('[data-turn-status="completed"]')).toBeVisible();
      await sendCompletedTurn(app, conversationId, `core:complete after ${decision}`);
      expect(app.rendererErrors).toEqual([]);
    } finally { await app.close(); }
  });
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
    try {
      await sendCompletedTurn(app, conversationId, "core:complete after cancellation and runtime recycle");
    } catch (error) {
      const { websocketUrl } = await app.runtimeSnapshot();
      if (websocketUrl) {
        const readiness = await new Promise<unknown>((resolve) => {
          const socket = new WebSocket(websocketUrl, { origin: "inertia://bundle", maxPayload: 2 * 1024 * 1024 });
          const finish = (value: unknown): void => { clearTimeout(timer); socket.terminate(); resolve(value); };
          const timer = setTimeout(() => finish(null), 2_000);
          socket.on("error", () => finish(null));
          socket.on("message", (data) => {
            try {
              const message = JSON.parse(data.toString()) as ServerEvent;
              const event = message.type === "runtime.event" ? message.event : message;
              if (event.type !== "server.welcome") return;
              finish(event.snapshot.providers.map((provider) => ({
                id: provider.id, available: provider.available, installState: provider.installState,
                authState: provider.authState, canRun: provider.canRun, capabilityContract: provider.capabilityContract,
              })));
            } catch { finish(null); }
          });
        });
        await test.info().attach("post-recycle-provider-readiness", {
          body: JSON.stringify(readiness, null, 2), contentType: "application/json",
        });
      }
      throw error;
    }
    expect(app.rendererErrors).toEqual([]);
  } finally {
    // The fixture rejects unless Electron, the runtime, provider ownership,
    // transport, preview server, and private temporary directory all close.
    // Observe concurrently: awaiting a diagnostic first could let an active
    // Git refresh finish and hide the immediate-shutdown race under test.
    const diagnostic = attachRuntimeLifecycleFailureDiagnostic(test.info(), async () =>
      (await app.runtimeSnapshot()).websocketUrl).catch(() => undefined);
    try {
      await app.close();
    } finally {
      await diagnostic;
    }
  }
});
