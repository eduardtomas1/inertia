// @inertia-e2e-resource isolated
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { focusAppWindow } from "./support/window-focus";

const ACTION_WINDOW_SECONDS = 3_600;
const RESUME_WINDOW_SECONDS = 90;

interface ResetState { resetsAt: number | null; windowSeconds: number; turns: number }

test("explicitly schedules, cancels, snoozes and resumes once after reset and restart", async () => {
  test.setTimeout(300_000);
  const environment: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" };
  let statePath = "";
  const readState = async (): Promise<ResetState> => JSON.parse(await readFile(statePath, "utf8")) as ResetState;
  const app: AppFixture = await createAppFixture({ name: "limit-reset", initialState: "conversation", additionalEnvironment: environment,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const home = join(testDirectory, "codex-home"); mkdirSync(home, { recursive: true });
      environment.CODEX_HOME = home;
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "fixture-subscription-account" } }));
      writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      statePath = join(testDirectory, "reset-state.json");
      writeFileSync(statePath, JSON.stringify({ resetsAt: null, windowSeconds: ACTION_WINDOW_SECONDS, turns: 0 } satisfies ResetState));
      const source = `
const fs = require("node:fs");
const path = ${JSON.stringify(statePath)};
if (process.argv.includes("--version")) { console.log("codex-cli 0.124.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("Usage: codex app-server [OPTIONS] - Run the app server"); process.exit(0); }
if (process.argv.includes("login")) { console.log("Logged in using ChatGPT"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "reset-fixture-thread";
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "reset-fixture" } });
  if (message.method === "model/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } } });
  if (message.method === "config/read") send({ id: message.id, result: { config: { cli_auth_credentials_store: "file" } } });
  if (message.method === "account/rateLimits/read") {
    const state = JSON.parse(fs.readFileSync(path, "utf8"));
    if (state.resetsAt === null) { state.resetsAt = Math.floor(Date.now() / 1000) + state.windowSeconds; fs.writeFileSync(path, JSON.stringify(state)); }
    const available = Date.now() >= state.resetsAt * 1000;
    send({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: available ? 0 : 100, windowDurationMins: 300, resetsAt: available ? state.resetsAt + 18000 : state.resetsAt } } } });
  }
  if (message.method === "thread/goal/get") send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") send({ id: message.id, result: { thread: { id: threadId }, model: "gpt-test", serviceTier: message.params.serviceTier ?? null } });
  if (message.method !== "turn/start") return;
  const state = JSON.parse(fs.readFileSync(path, "utf8")); state.turns += 1; fs.writeFileSync(path, JSON.stringify(state));
  const turn = { id: "reset-turn-" + state.turns, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: "Resumed after the subscription quota reset." } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});`;
      const binary = writeNodeFlagExecutable(join(testDirectory, "provider-bin"), "codex", source);
      environment.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED = binary;
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const chat = store.snapshot().conversations[0]!;
        const run = store.createWorkspaceRun({ kind: "agent", projectId: chat.projectId, conversationId: chat.id, label: "Task", detail: null, status: "running", port: null });
        const turn = store.beginAgentTurn({ conversationId: chat.id, runId: run.id, content: "Finish the task", providerId: chat.providerId,
          modelSelection: chat.modelSelection, model: "gpt-test", reasoningEffort: chat.reasoningEffort,
          accessMode: chat.accessMode, interactionMode: chat.interactionMode, configurationRevision: 0, association: "authoritative" }).turn;
        store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: turn.requestedAt });
        store.updateAgentTurnLifecycle(turn.id, { status: "failed", terminalReason: "provider-error", completedAt: new Date().toISOString() });
        store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: new Date().toISOString() });
        store.limitResets.markUsageLimited(turn.id);
        store.updateConversation(chat.id, { status: "failed" }); store.updateSettings({ codexBinaryPath: binary });
      } finally { store.close(); }
    },
  });
  const restart = async (): Promise<Page> => {
    const { electronApp, page } = await app.restart();
    await focusAppWindow(electronApp, page);
    return page;
  };
  let page = app.page;
  try {
    await focusAppWindow(app.electronApp, page);
    const resume = () => page.getByRole("button", { name: "Resume at reset", exact: true });
    await expect(resume()).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("limit-reset-offer.png"), animations: "disabled" });
    await resume().click();
    await expect(page.getByText("Resume scheduled", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel resume", exact: true }).click();
    await expect(resume()).toBeEnabled();
    await page.getByRole("button", { name: "Snooze until reset", exact: true }).click();
    await expect(page.getByRole("button", { name: "Snoozed until reset", exact: true })).toBeDisabled();
    expect((await readState()).turns).toBe(0);

    writeFileSync(statePath, JSON.stringify({ ...await readState(), resetsAt: null, windowSeconds: RESUME_WINDOW_SECONDS }));
    page = await restart();
    await expect(resume()).toBeEnabled();
    await resume().click();
    await expect(page.getByText("Resume scheduled", { exact: true })).toBeVisible();
    page = await restart();
    await expect(page.getByText("Resume scheduled", { exact: true })).toBeVisible();
    const { resetsAt } = await readState();
    const untilReset = Math.max(0, resetsAt! * 1000 - Date.now());
    await expect(page.getByText("Continue from where you stopped.", { exact: true })).toBeVisible({ timeout: untilReset + 60_000 });
    await expect(page.getByText("Resumed after the subscription quota reset.", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect((await readState()).turns).toBe(1);
    page = await restart();
    await expect(page.getByText("Resumed after the subscription quota reset.", { exact: true })).toBeVisible();
    expect((await readState()).turns).toBe(1);
  } catch (error) {
    await test.info().attach("runtime-state", { body: JSON.stringify(await app.runtimeSnapshot(), null, 2), contentType: "application/json" });
    throw error;
  } finally { await app.close(); }
});
