// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const metadataOnlyCodex = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS]\\n"); process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize" ? { userAgent: "synthetic-metadata" }
    : message.method === "model/list" ? { data: [], nextCursor: null } : { rateLimits: null };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;

const SYNTHETIC_CONVERSATION = "5c4a2d1e-7b3f-4e8a-9c6d-2f1e0b9a8c7d";
const RUNNING_TEXT = "Reading the ACP session adapter and its tests.";
const FINAL_TEXT = "The ACP adapter streams thoughts, tools, usage, and images with interactive approvals.";

function antigravitySource(wirePath: string, gatePath: string): string {
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ pid: process.pid, executable: process.argv[1], args, ...event }) + "\\n");
record({ kind: "launch" });
if (args[0] === "--version") { console.log("1.5.18"); process.exit(0); }
if (args[0] === "acp" && args[1] === "--help") {
  console.log("Usage: agy acp [options]\\n\\nStart the Agent Client Protocol (ACP) stdio server");
  process.exit(0);
}
if (args[0] !== "acp" || args.some(arg => arg === "-p" || arg === "--print" || arg === "--prompt" || arg === "--input-format")) {
  process.stderr.write("Unexpected synthetic Antigravity invocation.\\n");
  process.exit(2);
}
const sessionId = ${JSON.stringify(SYNTHETIC_CONVERSATION)};
let currentModeId = "default";
let currentModel = "gemini-4-neon";
let currentEffort = "medium";
let activeTimer = null;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const notify = (update) => send({ method: "session/update", params: { sessionId, update } });
const availableModes = [
  { id: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
  { id: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
  { id: "plan", name: "Plan", description: "Plan carefully before executing a task." },
];
const configOptions = () => [
  {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: currentModeId,
    options: availableModes.map(({ id, name, description }) => ({ value: id, name, description })),
  },
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel,
    options: [
      { value: "gemini-4-neon", name: "Gemini 4 Neon", description: "Default Antigravity model" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", description: "Fast Antigravity model" },
    ],
  },
  {
    id: "thinking_level", name: "Thinking level", category: "thought_level", type: "select", currentValue: currentEffort,
    options: [
      { value: "low", name: "Low", description: "Fast reasoning" },
      { value: "medium", name: "Medium", description: "Balanced reasoning" },
      { value: "high", name: "High", description: "Deep reasoning" },
      { value: "xhigh", name: "Extra high", description: "Deepest reasoning" },
    ],
  },
];
const sessionPayload = () => ({
  sessionId,
  modes: { currentModeId, availableModes },
  configOptions: configOptions(),
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  record({ kind: "rpc", method: message.method ?? "response" });
  if (message.method === "initialize") {
    const authMethods = [
      { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
      { id: "oauth-business", name: "Log in with Gemini Enterprise", description: "Log in with your Gemini Enterprise account" },
      { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
      { id: "agent-platform", name: "Gemini Enterprise Agent Platform", description: "Use Application Default Credentials" },
    ];
    if (message.params?.clientCapabilities?.auth?.terminal === true) {
      authMethods.push({ id: "terminal-login", name: "Log in from the terminal", description: "Paste an auth code", type: "terminal", args: ["--login"] });
    }
    return send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.18" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
        authMethods,
      },
    });
  }
  if (message.method === "session/new" || message.method === "session/resume" || message.method === "session/load") {
    return send({ id: message.id, result: sessionPayload() });
  }
  if (message.method === "session/set_mode") {
    if (typeof message.params?.modeId === "string") currentModeId = message.params.modeId;
    return send({ id: message.id, result: {} });
  }
  if (message.method === "session/set_config_option") {
    const { configId, value } = message.params ?? {};
    if (configId === "mode" && typeof value === "string") currentModeId = value;
    if (configId === "model" && typeof value === "string") currentModel = value;
    if ((configId === "thinking_level" || configId === "thought_level") && typeof value === "string") currentEffort = value;
    return send({ id: message.id, result: { configOptions: configOptions() } });
  }
  if (message.method === "session/prompt") {
    notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking the ACP adapter and tests." } });
    notify({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "view_file", kind: "read", status: "in_progress" });
    notify({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
    notify({ sessionUpdate: "tool_call", toolCallId: "call-2", title: "grep_search", kind: "search", status: "in_progress" });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(`${RUNNING_TEXT} `)} } });
    activeTimer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gatePath)})) return;
      clearInterval(activeTimer);
      activeTimer = null;
      record({ kind: "released" });
      notify({ sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed" });
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(FINAL_TEXT)} } });
      notify({ sessionUpdate: "usage_update", used: 2660, size: 1000000 });
      send({
        id: message.id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 1840, outputTokens: 212, thoughtTokens: 96, cachedReadTokens: 512, totalTokens: 2660 },
        },
      });
    }, 50);
    return;
  }
  if (message.method === "session/cancel") {
    if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
    if (message.id !== undefined) send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/close") {
    record({ kind: "exiting" });
    if (message.id !== undefined) send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`;
}

interface WireEntry {
  kind: "launch" | "rpc" | "released" | "exiting";
  method?: string;
  pid: number;
  executable: string;
  args: string[];
}

let app: AppFixture | undefined;

test.afterEach(async () => {
  const current = app;
  app = undefined;
  await current?.close();
});

async function captureElement(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await locator.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("shows Antigravity readiness, model choice, and a streamed turn from a fake agy", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000);
  let wirePath = "";
  let gatePath = "";
  let fakeAgy = "";
  let conversationId = "";
  const additionalEnvironment: Record<string, string> = {};
  app = await createAppFixture({
    name: "antigravity-evidence",
    initialState: "conversation",
    additionalEnvironment,
    codexAppServerSource: metadataOnlyCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const home = join(testDirectory, "provider-home");
      await Promise.all([bin, home].map((path) => mkdir(path, { recursive: true })));
      wirePath = join(home, "agy-wire.jsonl");
      gatePath = join(home, "release-turn");
      fakeAgy = writeNodeFlagExecutable(bin, "agy", antigravitySource(wirePath, gatePath));
      const systemPaths = process.platform === "win32"
        ? [dirname(process.execPath), join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"];
      for (const directory of ["/opt/homebrew/bin", "/usr/local/bin", ...systemPaths]) {
        for (const name of ["agy", "agy.cmd", "agy.exe", "antigravity", "antigravity.exe"]) {
          expect(existsSync(join(directory, name))).toBe(false);
        }
      }
      Object.assign(additionalEnvironment, {
        PATH: [bin, ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
        APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
        NVM_BIN: "", NVM_DIR: "", GEMINI_API_KEY: "", GOOGLE_GEMINI_BASE_URL: "",
      });
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) throw new Error("The synthetic conversation was not seeded.");
        conversationId = conversation.id;
        store.updateConversation(conversationId, {
          providerId: "antigravity",
          accessMode: "supervised",
          modelSelection: providerNativeModelSelection({ providerId: "antigravity" }),
        });
      } finally { store.close(); }
    },
  });
  const { page } = app;
  const wire = (): WireEntry[] => readFileSync(wirePath, "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as WireEntry);

  const openAntigravitySettings = async (theme: "Light" | "Dark"): Promise<void> => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const general = page.getByRole("button", { name: "Appearance", exact: true });
    if (await general.isVisible()) await general.click();
    await page.getByRole("radio", { name: theme }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const antigravity = page.getByRole("button", { name: "Configure Antigravity" });
    await antigravity.click();
    await expect(page.locator(".provider-settings-editor-header"))
      .toContainText("Antigravity checks your sign-in when a turn starts", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Configure Gemini/u })).toHaveCount(0);
    await expect(page.locator(".provider-settings-shell")).not.toContainText(/\bvv\d/u);
    const executable = page.getByRole("textbox", { name: "Antigravity executable path" });
    await expect(executable).not.toHaveValue("");
    expect(realpathSync.native(await executable.inputValue())).toBe(realpathSync.native(fakeAgy));
    const mark = antigravity.locator('[data-provider-brand="antigravity"]').first();
    await expect(mark).toHaveAttribute("data-provider-icon-kind", "official");
    await captureElement(antigravity, testInfo, `antigravity-mark-settings-${theme.toLowerCase()}`);
  };

  const chooseAntigravityModel = async (name: string, placeholder: RegExp, expectReasoningLevels: boolean): Promise<void> => {
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const composer = page.getByRole("region", { name: "Message composer" });
    const chip = composer.getByRole("button", { name: /^Choose model\./u });
    await expect(chip.locator('[data-provider-brand="antigravity"]').first())
      .toHaveAttribute("data-provider-icon-kind", "official");
    await captureElement(chip, testInfo, `antigravity-mark-chip-${name.endsWith("dark") ? "dark" : "light"}`);
    await expect(composer.getByRole("textbox", { name: "Message" }))
      .toHaveAttribute("placeholder", placeholder);
    await expect(composer.getByRole("button", {
      name: "Attach images, documents, or spreadsheets",
    })).toBeEnabled();
    if (process.platform === "linux") {
      await expect(composer.getByRole("button", { name: "Take reviewed screenshot" })).toBeEnabled();
    }
    const accessChip = composer.getByRole("button", { name: "Choose project access. Current access: Supervised." });
    await accessChip.click();
    const accessMenu = page.getByRole("menu", { name: "Project access" });
    const supervisedOption = accessMenu.getByRole("menuitemradio", { name: /Supervised/u });
    await expect(supervisedOption).toBeEnabled();
    await expect(supervisedOption).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(accessMenu).toBeHidden();
    if (expectReasoningLevels) {
      const reasoningChip = composer.getByRole("button", { name: /^Choose reasoning level\./u });
      await expect(reasoningChip).toBeVisible();
      await reasoningChip.click();
      const reasoningMenu = page.getByRole("menu", { name: "Reasoning level" });
      await expect(reasoningMenu.getByRole("menuitemradio", { name: /Extra high/u })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(reasoningMenu).toBeHidden();
    }
    await page.getByRole("button", { name: /^Choose model\./u }).click();
    const chooser = page.getByRole("dialog", { name: "Choose model" });
    const source = chooser.getByRole("button", { name: /^Antigravity, \d+ models?$/u });
    await source.click();
    await expect(source).toHaveAttribute("aria-pressed", "true");
    await capture(page, testInfo, name);
    await page.keyboard.press("Escape");
    await expect(chooser).toBeHidden();
  };

  const streamTurn = async (request: string, theme: "light" | "dark"): Promise<void> => {
    rmSync(gatePath, { force: true });
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const turn = page.locator("[data-turn-id]").filter({ has: page.getByText(request, { exact: true }) });
    await expect(turn.getByText(RUNNING_TEXT)).toBeVisible();
    await capture(page, testInfo, `running-turn-${theme}`);
    writeFileSync(gatePath, "release");
    try {
      await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      await testInfo.attach("antigravity-wire", {
        body: Buffer.from(existsSync(wirePath) ? readFileSync(wirePath, "utf8") : ""),
        contentType: "application/x-ndjson",
      });
      throw error;
    }
    await expect(turn.getByText(FINAL_TEXT)).toBeVisible();
    await capture(page, testInfo, `completed-turn-${theme}`);
  };

  await app.resizeWindow(1440, 920);
  await openAntigravitySettings("Light");
  await capture(page, testInfo, "provider-readiness-light");
  await chooseAntigravityModel("model-chooser-light", /^Ask anything\. @ files, (?:\$ skills, )?\/ commands$/u, false);
  await streamTurn("Check how the ACP adapter handles session updates.", "light");

  await openAntigravitySettings("Dark");
  await capture(page, testInfo, "provider-readiness-dark");
  await chooseAntigravityModel("model-chooser-dark", /^Follow up\. @ files, (?:\$ skills, )?\/ commands$/u, true);
  await streamTurn("Confirm usage and reasoning effort stay intact across turns.", "dark");

  const wireEntries = wire();
  const entries = wireEntries.filter(({ kind }) => kind === "launch");
  expect(entries.length).toBeGreaterThan(0);
  const fakeEntryPoints = [fakeAgy, join(dirname(fakeAgy), "agy-fixture.cjs")].map((path) => realpathSync.native(path));
  for (const entry of entries) {
    expect(fakeEntryPoints).toContain(realpathSync.native(entry.executable));
    expect(entry.args.some((arg) => arg === "-p" || arg === "--print" || arg === "--prompt" || arg === "--input-format")).toBe(false);
  }
  const acpLaunches = entries.filter(({ args }) => args[0] === "acp" && args.includes("--stdio") && args.includes("--process-per-session"));
  expect(acpLaunches.length).toBeGreaterThanOrEqual(2);
  expect(wireEntries.filter(({ kind, method }) => kind === "rpc" && method === "session/prompt")).toHaveLength(2);
  expect(conversationId).not.toBe("");
  expect(app.rendererErrors).toEqual([]);
});
