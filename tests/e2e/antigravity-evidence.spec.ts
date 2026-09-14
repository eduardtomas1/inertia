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
const RUNNING_TEXT = "Reading the stream parser and its tests.";
const FINAL_TEXT = "The parser accepts nested and flat step updates, and every non-success result fails the turn.";

function antigravitySource(wirePath: string, gatePath: string): string {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(${JSON.stringify(wirePath)}, JSON.stringify({ pid: process.pid, executable: process.argv[1], args, ...event }) + "\\n");
record({ kind: "launch" });
if (args[0] === "--version") { console.log("1.2.2"); process.exit(0); }
const streamJson = args[0] === "--input-format" && args[1] === "stream-json"
  && args[2] === "--output-format" && args[3] === "stream-json";
if (!streamJson || args.some(arg => arg === "-p" || arg === "--print" || arg === "--prompt")) {
  process.stderr.write("Unexpected synthetic Antigravity invocation.\\n");
  process.exit(2);
}
const conversation = ${JSON.stringify(SYNTHETIC_CONVERSATION)};
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const step = (index, fields) => emit({ event: "step_update", step_update: { conversation_id: conversation, step_index: index, ...fields } });
process.stdin.resume();
process.stdin.on("end", () => {
  emit({ event: "init", init: { conversation_id: conversation } });
  step(0, { state: "ACTIVE", tool_name: "view_file" });
  step(0, { state: "DONE", tool_name: "view_file" });
  step(1, { state: "ACTIVE", tool_name: "grep_search" });
  step(2, { state: "ACTIVE", text_delta: ${JSON.stringify(`${RUNNING_TEXT} `)} });
  const release = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(gatePath)})) return;
    clearInterval(release);
    record({ kind: "released" });
    step(1, { state: "DONE", tool_name: "grep_search" });
    step(3, { state: "DONE", text_delta: ${JSON.stringify(FINAL_TEXT)} });
    emit({ event: "result", result: {
      conversation_id: conversation, status: "SUCCESS", response: "", error: "",
      duration_seconds: 4, num_turns: 1,
      usage: { input_tokens: 1840, output_tokens: 212, thinking_tokens: 96, cache_read_tokens: 512, total_tokens: 2660 },
    } });
    process.stdout.write("", () => { record({ kind: "exiting" }); process.exit(0); });
  }, 50);
});
`;
}

interface WireEntry {
  kind: "launch" | "released" | "exiting";
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
    const general = page.getByRole("button", { name: "General", exact: true });
    if (await general.isVisible()) await general.click();
    await page.getByRole("radio", { name: theme }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    const antigravity = page.getByRole("button", { name: "Configure Antigravity" });
    await expect(antigravity).toContainText("Antigravity checks your sign-in when a turn starts", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Configure Gemini/u })).toHaveCount(0);
    await antigravity.click();
    await expect(page.locator(".provider-settings-shell")).not.toContainText(/\bvv\d/u);
    await expect(page.locator(".provider-settings-shell")).not.toContainText(/gemini/iu);
    const executable = page.getByRole("textbox", { name: "Antigravity executable path" });
    await expect(executable).not.toHaveValue("");
    expect(realpathSync(await executable.inputValue())).toBe(realpathSync(fakeAgy));
    const mark = antigravity.locator('[data-provider-brand="antigravity"]').first();
    await expect(mark).toHaveAttribute("data-provider-icon-kind", "official");
    await captureElement(antigravity, testInfo, `antigravity-mark-settings-${theme.toLowerCase()}`);
  };

  const chooseAntigravityModel = async (name: string): Promise<void> => {
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const composer = page.getByRole("region", { name: "Message composer" });
    const chip = composer.getByRole("button", { name: /^Choose model\./u });
    await expect(chip.locator('[data-provider-brand="antigravity"]').first())
      .toHaveAttribute("data-provider-icon-kind", "official");
    await captureElement(chip, testInfo, `antigravity-mark-chip-${name.endsWith("dark") ? "dark" : "light"}`);
    await expect(composer.getByRole("textbox", { name: "Message" }))
      .toHaveAttribute("placeholder", "Ask for follow-up changes");
    await expect(composer.getByRole("button", {
      name: "Attach documents or spreadsheets. Antigravity can't read images in Inertia.",
    })).toBeEnabled();
    await expect(composer.getByRole("button", { name: "Snapshots. Antigravity can't read images in Inertia.", exact: true }))
      .toBeDisabled();
    await expect(composer.getByRole("button", { name: "Snapshots", exact: true })).toHaveCount(0);
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
  await chooseAntigravityModel("model-chooser-light");
  await streamTurn("Check how the stream parser handles step updates.", "light");

  await openAntigravitySettings("Dark");
  await capture(page, testInfo, "provider-readiness-dark");
  await chooseAntigravityModel("model-chooser-dark");
  await streamTurn("Confirm non-success results fail the turn.", "dark");

  const entries = wire().filter(({ kind }) => kind === "launch");
  expect(entries.length).toBeGreaterThan(0);
  const fakeEntryPoints = [fakeAgy, join(dirname(fakeAgy), "agy-fixture.cjs")].map((path) => realpathSync(path));
  for (const entry of entries) {
    expect(fakeEntryPoints).toContain(realpathSync(entry.executable));
    expect(entry.args.some((arg) => arg === "-p" || arg === "--print" || arg === "--prompt")).toBe(false);
  }
  const turns = entries.filter(({ args }) => args[0] === "--input-format");
  expect(turns.map(({ args }) => args)).toEqual([
    ["--input-format", "stream-json", "--output-format", "stream-json"],
    ["--input-format", "stream-json", "--output-format", "stream-json", "--conversation", SYNTHETIC_CONVERSATION],
  ]);
  expect(conversationId).not.toBe("");
  expect(app.rendererErrors).toEqual([]);
});
