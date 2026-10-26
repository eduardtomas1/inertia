// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const evidenceDirectory = process.env.INERTIA_UPDATE_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_UPDATE_EVIDENCE_DIR)
  : null;

const installedVersion = "0.124.0";
const latestVersion = "0.125.0";
const request = "Refactor the parser module and keep the public API.";
const continuation = "Continue from where you stopped.";
const continuedAnswer = "Picked up the parser refactor where it stopped.";
const restartNote = "Inertia stopped while your previous turn was running";

interface FakeCodex {
  versionPath: string;
  requestsPath: string;
  brewPath: string;
  brewGatePath: string;
}

interface RecordedRequest {
  method: string;
  threadId?: string;
  input?: unknown;
  pid: number;
  version: string;
}

function fakeCodexSource(fake: FakeCodex): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const version = () => fs.readFileSync(${JSON.stringify(fake.versionPath)}, "utf8").trim();
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli " + version() + "\\n"); process.exit(0); }
if (args.includes("--help")) { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
if (args[0] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
if (args[0] !== "app-server") process.exit(2);
const record = (entry) => fs.appendFileSync(${JSON.stringify(fake.requestsPath)},
  JSON.stringify({ ...entry, pid: process.pid, version: version() }) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const turn = (id, status) => ({ id, status, items: [], error: null });
let threadId = "update-everything-thread";
let sequence = 0;
let held = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "update-everything-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } } });
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    record({ method: message.method, threadId });
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") {
    record({ method: message.method, threadId: message.params.threadId });
    send({ id: message.id, result: {} });
    if (held) send({ method: "turn/completed", params: { threadId, turn: turn(held, "interrupted") } });
    held = null;
    return;
  }
  if (message.method !== "turn/start") return;
  sequence += 1;
  const turnId = "update-everything-turn-" + process.pid + "-" + sequence;
  record({ method: message.method, threadId: message.params.threadId, input: message.params.input });
  send({ id: message.id, result: { turn: turn(turnId, "inProgress") } });
  send({ method: "turn/started", params: { threadId, turn: turn(turnId, "inProgress") } });
  if (!JSON.stringify(message.params.input).includes(${JSON.stringify(continuation)})) {
    held = turnId;
    return;
  }
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "answer-" + sequence, delta: ${JSON.stringify(continuedAnswer)} } });
  send({ method: "turn/completed", params: { threadId, turn: turn(turnId, "completed") } });
});
`;
}

function fakeBrewSource(fake: FakeCodex): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(`${fake.brewPath}.log`)}, JSON.stringify(args) + "\\n");
if (args[0] === "info") {
  process.stdout.write(JSON.stringify({ formulae: [{ versions: { stable: ${JSON.stringify(latestVersion)} } }], casks: [] }));
  process.exit(0);
}
if (args[0] !== "upgrade" || args[1] !== "codex") process.exit(1);
const finish = () => {
  if (!fs.existsSync(${JSON.stringify(fake.brewGatePath)})) return setTimeout(finish, 25);
  fs.writeFileSync(${JSON.stringify(fake.versionPath)}, ${JSON.stringify(`${latestVersion}\n`)});
  process.stdout.write("==> Upgrading codex ${installedVersion} -> ${latestVersion}\\n");
  process.exit(0);
};
finish();
`;
}

async function openUpdatableApp(name: string): Promise<{ app: AppFixture; fake: FakeCodex }> {
  test.skip(process.platform === "win32", "Homebrew kegs exist only on macOS and Linux");
  const environment: Record<string, string> = { OPENAI_API_KEY: "", CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "" };
  let fake!: FakeCodex;
  const app = await createAppFixture({
    name,
    initialState: "conversation",
    additionalEnvironment: environment,
    beforeLaunch: ({ testDirectory }) => {
      const home = join(testDirectory, "codex-home");
      mkdirSync(home, { recursive: true });
      environment.CODEX_HOME = home;
      const prefix = join(testDirectory, "brew");
      const keg = join(prefix, "Cellar", "codex", installedVersion, "bin");
      mkdirSync(keg, { recursive: true });
      mkdirSync(join(prefix, "bin"), { recursive: true });
      fake = {
        versionPath: join(testDirectory, "codex-version.txt"),
        requestsPath: join(testDirectory, "codex-requests.jsonl"),
        brewPath: join(prefix, "bin", "brew"),
        brewGatePath: join(testDirectory, "brew-upgrade-release"),
      };
      writeFileSync(fake.versionPath, `${installedVersion}\n`);
      writeFileSync(join(keg, "codex"), fakeCodexSource(fake), { mode: 0o755 });
      writeFileSync(fake.brewPath, fakeBrewSource(fake), { mode: 0o755 });
      const codex = join(testDirectory, "provider-bin", "codex");
      symlinkSync(join(keg, "codex"), codex);
      environment.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED = codex;
    },
  });
  await setAppearanceInPlace(app, "light");
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  return { app, fake };
}

async function recorded(fake: FakeCodex): Promise<RecordedRequest[]> {
  const text = await readFile(fake.requestsPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordedRequest);
}

async function brewCalls(fake: FakeCodex): Promise<string[][]> {
  const text = await readFile(`${fake.brewPath}.log`, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

function updateControl(page: Page): Locator {
  return page.locator(".sidebar-update-button");
}

function turnRow(page: Page, content: string): Locator {
  return page.locator("[data-turn-id]").filter({ has: page.getByText(content, { exact: true }) });
}

function interruption(page: Page): Locator {
  return turnRow(page, request).getByRole("region", { name: "Codex · OpenAI activity" }).getByRole("group").first();
}

async function startHeldTurn(app: AppFixture, fake: FakeCodex): Promise<void> {
  const composer = app.page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill(request);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(composer.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await expect.poll(async () => (await recorded(fake)).filter(({ method }) => method === "turn/start").length).toBe(1);
}

async function openDialog(page: Page): Promise<Locator> {
  await expect(updateControl(page)).toHaveAttribute("aria-label", "Update Codex", { timeout: 30_000 });
  await updateControl(page).click();
  const dialog = page.getByRole("dialog", { name: "Update Codex?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveText([`Codex ${installedVersion} → ${latestVersion}`]);
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  return dialog;
}

async function capture(page: Page, name: string, hover?: Locator, animations: "disabled" | "allow" = "disabled"): Promise<void> {
  if (!evidenceDirectory) return;
  if (hover) await hover.hover();
  else await page.mouse.move(0, 0);
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), animations });
}

function recordFrames(page: Page): () => Promise<void> {
  if (!evidenceDirectory) return async () => undefined;
  const directory = join(evidenceDirectory, "update-gif-frames");
  let recording = true;
  const loop = (async () => {
    await mkdir(directory, { recursive: true });
    const started = Date.now();
    for (let frame = 0; recording; frame += 1) {
      const due = started + frame * 200;
      await new Promise((settle) => setTimeout(settle, Math.max(0, due - Date.now())));
      await page.screenshot({ path: join(directory, `frame-${String(frame).padStart(4, "0")}.png`) });
    }
  })();
  return async () => {
    recording = false;
    await loop;
  };
}

test("updates Codex, interrupts the running chat and continues it on the same thread", async () => {
  test.setTimeout(150_000);
  const { app, fake } = await openUpdatableApp("update-everything");
  try {
    const { page } = app;
    await startHeldTurn(app, fake);
    await expect(updateControl(page)).toHaveAttribute("aria-label", "Update Codex", { timeout: 30_000 });
    await capture(page, "sidebar-control", updateControl(page));
    await page.mouse.move(0, 0);
    const stopFrames = recordFrames(page);
    if (evidenceDirectory) await page.waitForTimeout(600);
    const dialog = await openDialog(page);
    await expect(dialog.getByText("1 running chat will be interrupted and will continue after the update.", { exact: true })).toBeVisible();
    const keepGoing = dialog.getByRole("checkbox", { name: "Continue chats after the update" });
    await expect(keepGoing).toBeChecked();
    if (evidenceDirectory) await page.waitForTimeout(1_000);
    await capture(page, "dialog");
    await dialog.getByRole("button", { name: "Update", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Updating Codex…", exact: true })).toBeVisible();
    await expect(updateControl(page)).toHaveAttribute("aria-label", "Update details");
    await expect(interruption(page)).toContainText("Stopped to update Codex. The chat continues after the update.");
    await expect.poll(async () => (await brewCalls(fake)).some((args) => args[0] === "upgrade")).toBe(true);
    expect((await brewCalls(fake)).filter((args) => args[0] === "upgrade")).toEqual([["upgrade", "codex"]]);
    if (evidenceDirectory) await page.waitForTimeout(1_000);
    await capture(page, "updating", updateControl(page));
    await page.mouse.move(0, 0);
    await capture(page, "updating-strip");
    await writeFile(fake.brewGatePath, "release\n", "utf8");

    await expect(page.getByText(`Updated to ${latestVersion}`, { exact: true })).toBeVisible();
    const continued = turnRow(page, continuation);
    await expect(page.getByRole("button", { name: `Codex updated to ${latestVersion}`, exact: true })).toBeVisible();
    await capture(page, "updated-strip", undefined, "allow");
    await expect(continued.getByText(continuedAnswer, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(updateControl(page)).not.toHaveAttribute("aria-label", "Update details");
    if (evidenceDirectory) await page.waitForTimeout(1_200);
    await stopFrames();
    await capture(page, "continued");

    const requests = await recorded(fake);
    const turnStarts = requests.filter(({ method }) => method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    const [first, second] = turnStarts;
    expect(first!.version).toBe(installedVersion);
    expect(second!.version).toBe(latestVersion);
    expect(second!.threadId).toBe(first!.threadId);
    expect(JSON.stringify(second!.input)).toContain(restartNote);
    const opened = requests.filter(({ method }) => method === "thread/start" || method === "thread/resume");
    expect(opened.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(opened.filter(({ method }) => method === "thread/resume").every(({ threadId }) => threadId === first!.threadId)).toBe(true);
    await expect(page.getByText(continuation, { exact: true })).toHaveCount(1);
    await expect(page.getByText(new RegExp(restartNote, "u"))).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("interrupts the running chat without continuing it when continuation is turned off", async () => {
  test.setTimeout(120_000);
  const { app, fake } = await openUpdatableApp("update-everything-no-continue");
  try {
    const { page } = app;
    await startHeldTurn(app, fake);
    const dialog = await openDialog(page);
    const keepGoing = dialog.getByRole("checkbox", { name: "Continue chats after the update" });
    await expect(keepGoing).toBeChecked();
    await keepGoing.uncheck();
    await expect(dialog.getByText("1 running chat will be interrupted.", { exact: true })).toBeVisible();
    await writeFile(fake.brewGatePath, "release\n", "utf8");
    await dialog.getByRole("button", { name: "Update", exact: true }).click();

    await expect(interruption(page)).toContainText("Stopped to update Codex.");
    await expect(interruption(page)).not.toContainText("continues after the update");
    await expect(page.getByText(`Updated to ${latestVersion}`, { exact: true })).toBeVisible();
    await expect(updateControl(page)).not.toHaveAttribute("aria-label", "Updating Codex…");
    const settledAt = Date.now();
    await expect.poll(async () => ({
      turns: (await recorded(fake)).filter(({ method }) => method === "turn/start").length,
      waited: Date.now() - settledAt >= 12_000,
    }), { intervals: [500], timeout: 30_000 }).toEqual({ turns: 1, waited: true });
    await expect(page.getByText(continuation, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Message composer" })
      .getByRole("button", { name: "Send message" })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
