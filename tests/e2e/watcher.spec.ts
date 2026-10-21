// @inertia-e2e-resource isolated
import { expect, test, type Locator, type TestInfo } from "@playwright/test";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { closeWorkspaceTools, ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const WATCHED_TITLE = "Parser cleanup";
const SPLIT_TITLES = ["Release notes", "Docs sweep", "Flaky test triage"];
const BRIEF = "Tidy the line parser and keep its behaviour.";
const FINDING = "Empty lines lost their test: parseLine now returns early for an empty string, "
  + "but the case that covered it was removed from tests/parser.test.ts.";
const MAIN_ANSWER = "The parser is tidier and the existing tests pass.";
const NOTE_ANSWER = "Restored the empty-line test in tests/parser.test.ts.";
const DISMISSED = "The diff stat lists only src/parser.ts.";
const FOLLOW_UP = "Add a changelog line for the parser fix.";
const AUTO_FINDING = "The changelog line names the lexer, but the fix is in src/parser.ts.";

const watcherAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const dataDirectory = path.resolve(process.cwd(), "..", "data");
const steps = [
  ["main-step-1", "rg -n parseLine src", "src/parser.ts:12:export function parseLine(line) {"],
  ["main-step-2", "git diff --stat", " src/parser.ts | 9 +++------"],
  ["main-step-2b", "git status --short", " M src/parser.ts"],
  ["main-step-3", "npm test -- parser", "4 passing"],
];
let threadId = "watcher-thread-" + process.pid;
let active = null;
let sequence = 0;
const finish = (turn, status, text) => {
  if (turn.settled) return;
  turn.settled = true;
  if (turn.timer) clearTimeout(turn.timer);
  if (text && status === "completed") {
    send({ method: "item/completed", params: { threadId, turnId: turn.id, completedAtMs: Date.now(), item: {
      id: turn.id + "-answer", type: "agentMessage", text, phase: "final_answer",
    } } });
  }
  send({ method: "turn/completed", params: { threadId, turn: {
    id: turn.id, status, items: [], error: status === "failed" ? { message: text } : null,
  } } });
};
const waitFor = (turn, probe, then) => {
  const deadlineAt = Date.now() + 60000;
  const inspect = () => {
    if (turn.settled) return;
    const value = probe();
    if (value !== null) { then(value); return; }
    if (Date.now() >= deadlineAt) { finish(turn, "failed", "Watcher fixture gate timed out."); return; }
    turn.timer = setTimeout(inspect, 25);
  };
  inspect();
};
const gate = (name) => () => fs.existsSync(path.join(dataDirectory, name)) ? true : null;
const claimReply = () => {
  const names = fs.readdirSync(dataDirectory).filter((name) => name.startsWith("watcher-reply-")).sort();
  for (const name of names) {
    const claimed = path.join(dataDirectory, "claimed-" + process.pid + "-" + name);
    try { fs.renameSync(path.join(dataDirectory, name), claimed); } catch { continue; }
    return fs.readFileSync(claimed, "utf8");
  }
  return null;
};
const command = (turn, index, step) => {
  const item = { id: turn.id + "-command-" + index, type: "commandExecution", command: step[1], status: "inProgress" };
  send({ method: "item/started", params: { threadId, turnId: turn.id, startedAtMs: Date.now(), item } });
  send({ method: "item/completed", params: { threadId, turnId: turn.id, completedAtMs: Date.now(), item: {
    ...item, status: "completed", exitCode: 0, aggregatedOutput: step[2] + "\\n",
  } } });
};
const runSteps = (turn, index) => {
  if (index >= steps.length) {
    waitFor(turn, gate("main-finish"), () => finish(turn, "completed", ${JSON.stringify(MAIN_ANSWER)}));
    return;
  }
  waitFor(turn, gate(steps[index][0]), () => { command(turn, index, steps[index]); runSteps(turn, index + 1); });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "watcher-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (active) finish(active, "interrupted", null);
    return;
  }
  if (message.method !== "turn/start") {
    if (message.id !== undefined) send({ id: message.id, result: {} });
    return;
  }
  sequence += 1;
  const turn = { id: "watcher-turn-" + process.pid + "-" + sequence, settled: false, timer: null };
  active = turn;
  send({ id: message.id, result: { turn: { id: turn.id, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turn.id, status: "inProgress", items: [], error: null } } });
  const text = (message.params.input || []).filter((item) => item && item.type === "text").map((item) => item.text || "").join("\\n");
  if (message.params.outputSchema) return finish(turn, "completed", JSON.stringify({ title: "Parser cleanup" }));
  if (text.includes("[inertia-watcher]")) return waitFor(turn, claimReply, (reply) => finish(turn, "completed", reply));
  if (text.includes("[inertia-watcher-note]")) return finish(turn, "completed", ${JSON.stringify(NOTE_ANSWER)});
  runSteps(turn, 0);
});
`;

let app!: AppFixture;
let replySequence = 0;
const sentFrames: string[] = [];

test.describe.configure({ mode: "serial" });

test.describe("watcher on the fake Codex route", () => {
  test.beforeAll(async () => {
    app = await createAppFixture({
      name: "watcher",
      initialState: "conversation",
      codexAppServerSource: watcherAppServer,
      beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
        const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
          recoverInterruptedRuns: false,
        });
        try {
          const watched = store.snapshot().conversations.find(({ title }) => title === "watcher fixture");
          for (const title of SPLIT_TITLES) store.createConversation(watched!.projectId, title);
          store.updateConversation(watched!.id, { title: WATCHED_TITLE });
          store.selectConversation(watched!.id);
        } finally {
          store.close();
        }
      },
    });
    app.page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        sentFrames.push(typeof payload === "string" ? payload : payload.toString("utf8"));
      });
    });
    await app.page.reload();
    await app.page.locator('.app-shell[data-connection-status="online"]').waitFor();
    await app.page.getByRole("textbox", { name: "Message" }).waitFor();
    await app.resizeWindow(1440, 900);
    await setAppearanceInPlace(app, "light");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  const gate = async (name: string): Promise<void> => {
    await writeFile(join(app.testDirectory, "data", name), "ready\n", "utf8");
  };
  const queueWatcherReply = async (reply: string): Promise<void> => {
    replySequence += 1;
    const name = `watcher-reply-${String(replySequence).padStart(2, "0")}`;
    const staging = join(app.testDirectory, `${name}.staging`);
    await writeFile(staging, reply, "utf8");
    await rename(staging, join(app.testDirectory, "data", name));
  };

  async function capture(info: TestInfo, name: string): Promise<void> {
    const path = info.outputPath(`${name}.png`);
    await app.page.mouse.move(0, 0);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(name, { path, contentType: "image/png" });
  }

  const dock = (): Locator => app.page.locator("aside.watcher-dock");
  const handle = (): Locator => app.page.getByRole("button", { name: /^Open watcher/u });
  const phase = (): Locator => dock().locator(".watcher-bar-state");
  const feedEntries = (): Locator => dock().locator(".watcher-feed-list > li");
  const expectMenuNote = async (text: string | RegExp): Promise<void> => {
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    const menu = app.page.getByRole("menu", { name: "More watcher actions" });
    await expect(menu.getByRole("menuitem", { name: text, exact: true })).toBeVisible();
    await expect(menu.locator(":focus")).toHaveCount(1);
    await app.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  };
  const readMenuNote = async (pattern: RegExp): Promise<string> => {
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    const menu = app.page.getByRole("menu", { name: "More watcher actions" });
    const note = menu.getByRole("menuitem", { name: pattern });
    await expect(note).toBeVisible();
    const text = await note.textContent();
    await app.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    return text ?? "";
  };
  const sidebar = (): Locator => app.page.getByRole("complementary", { name: "Project navigation", exact: true });
  const watchedRow = (): Locator => sidebar().locator("button.activity-thread-select").filter({ hasText: WATCHED_TITLE });

  async function watcherConversationId(): Promise<string> {
    const focusId = await sidebar().locator(".watcher-work-row").getAttribute("data-work-focus-id");
    expect(focusId).toMatch(/^watcher:/u);
    return focusId!.slice("watcher:".length);
  }

  test("attaches a Reviewer watcher to a running chat and opens its dock", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(BRIEF);
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(BRIEF, { exact: true }).first()).toBeVisible();
    await expect(composer.getByRole("button", { name: /^Stop/u })).toBeVisible();

    await page.locator(".workspace-header .header-title-button").click();
    const menu = page.getByRole("menu", { name: `Thread actions for ${WATCHED_TITLE}` });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Add a watcher…" }).click();

    const dialog = page.getByRole("dialog", { name: "Add a watcher" });
    await expect(dialog).toBeVisible();
    const presets = dialog.getByRole("radiogroup", { name: "Preset" });
    await expect(presets.getByRole("radio")).toHaveCount(3);
    await expect(dialog.getByText("No watcher route", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Model route unavailable", { exact: true })).toHaveCount(0);
    await presets.getByRole("radio", { name: /^Reviewer/u }).click();
    await expect(presets.getByRole("radio", { name: /^Reviewer/u })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("It reads and reports: it may run read-only commands and never edits files or changes the workspace.", { exact: true })).toBeVisible();
    const attach = dialog.getByRole("button", { name: "Add watcher" });
    await expect(attach).not.toHaveAttribute("aria-disabled");
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    await capture(info, "attach-dialog-light");

    const framesBeforeAttach = sentFrames.length;
    await attach.click();
    await expect(dialog).toHaveCount(0);
    await expect(dock()).toBeVisible();
    await expect.poll(() => sentFrames.slice(framesBeforeAttach).some((frame) => frame.includes('"watcher.feed.get"'))).toBe(true);
    await expect(dock().getByRole("heading", { level: 2 })).toHaveText(`Watching ${WATCHED_TITLE}`);
    await expect(dock().getByRole("heading", { level: 2 })).toBeFocused();
    await expect(phase()).toHaveText(/^.+ · Reviewer · Watching$/u);
    await expectMenuNote(/^\d+ of 30 checks left this turn$/u);
    await expect(dock().getByRole("button", { name: "More watcher actions" })).toBeFocused();
    await expect(page.locator(".watcher-dock-frame")).toHaveAttribute("data-presentation", "inline");
    await expect(page.getByRole("main", { name: "Split conversation workspace" })).toHaveCount(0);
    await expect.poll(async () => {
      const chatBox = await page.locator(".workspace-chat-column").boundingBox();
      const dockBox = await dock().boundingBox();
      return chatBox && dockBox ? Math.round(dockBox.x - (chatBox.x + chatBox.width)) : null;
    }).toBeGreaterThanOrEqual(-1);
    await expect(handle()).toHaveCount(0);
    await expect(dock().getByText(/No checks yet/u)).toBeVisible();
    await capture(info, "gif-02-dock-open");
    await capture(info, "dock-empty-light");
    expect(app.rendererErrors).toEqual([]);
  });

  test("shows a check in progress and folds quiet checks into one receipt", async ({ browserName: _browserName }, info) => {
    await gate("main-step-1");
    await expectMenuNote("1 event waiting");
    await dock().getByRole("button", { name: "Check now" }).click();
    await expect(phase()).toHaveAttribute("data-phase", "waking");
    await expect(dock().locator(".watcher-notice-line")).toHaveText(/^Check 1$/u);
    await expect(dock().getByRole("button", { name: "Check now" })).toHaveAttribute("aria-disabled", "true");
    await expect(sidebar().locator(".watcher-work-row-state")).toHaveText("Checking");
    await capture(info, "dock-checking-light");

    await queueWatcherReply("SILENT");
    const receipt = dock().locator(".watcher-receipt:not(.is-notice) summary");
    await expect(receipt).toHaveText(/^Checked once · .+ · nothing to report/u);
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");

    await gate("main-step-2");
    await expectMenuNote("1 event waiting");
    await dock().getByRole("button", { name: "Check now" }).click();
    await expect(phase()).toHaveAttribute("data-phase", "waking");
    await queueWatcherReply("SILENT");
    await expect(receipt).toHaveText(/^Checked 2 times · .+ · nothing to report/u);
    await expect(dock().locator(".watcher-receipt:not(.is-notice)")).toHaveCount(1);
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");
    await expectMenuNote("0 events waiting");
    await receipt.click();
    await expect(dock().locator(".watcher-receipt-checks > li")).toHaveCount(2);
    await capture(info, "dock-receipts-light");
    await receipt.click();
    expect(app.rendererErrors).toEqual([]);
  });

  test("pauses, resumes and dismisses a finding from the dock", async ({ browserName: _browserName }) => {
    const page = app.page;
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    await page.getByRole("menu", { name: "More watcher actions" }).getByRole("menuitem", { name: "Pause", exact: true }).click();
    await expect(phase()).toHaveText(/ · Paused$/u);
    await expect(dock().getByRole("button", { name: "Check now" })).toHaveCount(0);
    await dock().getByRole("button", { name: "Resume", exact: true }).click();
    await expect(phase()).toHaveText(/ · Watching$/u);

    await gate("main-step-2b");
    await expectMenuNote("1 event waiting");
    await dock().getByRole("button", { name: "Check now" }).click();
    await expect(phase()).toHaveAttribute("data-phase", "waking");
    await queueWatcherReply(DISMISSED);
    const card = dock().getByRole("article", { name: DISMISSED });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(dock().getByRole("heading", { level: 2 })).toBeFocused();
    await expect(feedEntries()).toHaveCount(1);
    await expect(feedEntries().first().locator("summary")).toHaveText(/^Checked 2 times · .+ · nothing to report/u);
    expect(app.rendererErrors).toEqual([]);
  });

  test("queues a finding and delivers it after the watched turn as a watcher note", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    await gate("main-step-3");
    await expectMenuNote("1 event waiting");
    await dock().getByRole("button", { name: "Check now" }).click();
    await expect(phase()).toHaveAttribute("data-phase", "waking");
    await queueWatcherReply(FINDING);
    const finding = dock().getByRole("article", { name: FINDING });
    await expect(finding).toBeVisible();
    await expect(finding).toContainText("Empty lines lost their test:");
    await expect(finding.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(finding.getByRole("button", { name: "Dismiss", exact: true })).toBeEnabled();
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");
    await capture(info, "dock-finding-light");
    await setAppearanceInPlace(app, "dark");
    await expect(finding).toBeVisible();
    await capture(info, "dock-finding-dark");
    await setAppearanceInPlace(app, "light");

    await finding.getByRole("button", { name: "Send", exact: true }).click();
    const status = finding.locator(".watcher-finding-status");
    await expect(status).toHaveText(/^Queued · sends after the current turn$/u);
    await expect(status).toBeFocused();
    await expect(finding.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    const queue = page.getByText("From watcher", { exact: true });
    await expect(queue.first()).toBeVisible();
    await capture(info, "gif-06-sent");

    const findingCheck = (await finding.locator(".watcher-finding-meta").textContent())?.match(/^Check (\d+)/u)?.[1];
    expect(findingCheck).toBeDefined();
    await queueWatcherReply(`SILENT\nResolved: check ${findingCheck}`);
    await queueWatcherReply("SILENT");
    await gate("main-finish");
    await expect(page.getByText(MAIN_ANSWER, { exact: true }).first()).toBeVisible();
    const divider = page.getByRole("separator", { name: /^Note from watcher · Reviewer · /u });
    await expect(divider).toBeVisible();
    await expect(page.getByText(NOTE_ANSWER, { exact: true }).first()).toBeVisible();
    const bubble = page.getByLabel("Note from watcher", { exact: true }).first();
    await expect(bubble).toContainText("Empty lines lost their test:");
    await expect(bubble.locator(".message-watcher-origin")).toHaveText("From watcher");
    await capture(info, "main-chat-note-light");
    await expect(status).toHaveText(/^Sent \d{1,2}:\d{2}\s[AP]M · after the turn ended$/u);
    await expect(page.locator('.response-turn [data-turn-status="completed"]')).toHaveCount(2);
    await expect(page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    await expect(feedEntries()).toHaveCount(3);
    await expect(feedEntries().nth(0)).toHaveAttribute("data-kind", "receipts");
    await expect(feedEntries().nth(0).locator("summary")).toHaveText(/^Checked 2 times · .+ · nothing to report/u);
    await expect(feedEntries().nth(1)).toHaveAttribute("data-kind", "finding");
    await expect(feedEntries().nth(2)).toHaveAttribute("data-kind", "receipts");
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");
    await expect(dock().locator(".watcher-notice-line")).toHaveCount(0);
    await expect(finding.locator(".watcher-finding-meta").first()).toHaveText(new RegExp(`^Check ${findingCheck} · .+ · resolved in check ${Number(findingCheck) + 1}$`, "u"));
    await capture(info, "dock-resolved-light");
    expect(app.rendererErrors).toEqual([]);
  });

  test("nests the watcher under its chat in the Work tab", async ({ browserName: _browserName }, info) => {
    const row = sidebar().locator(".activity-thread.is-watcher");
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button")).toHaveAccessibleName(
      new RegExp(`^Watcher · Reviewer, watching ${WATCHED_TITLE}`, "u"),
    );
    const order = await sidebar().getByRole("list", { name: "Work", exact: true }).evaluate((list, title) => {
      const items = [...list.querySelectorAll<HTMLElement>('[role="listitem"]')];
      const parent = items.findIndex((item) =>
        !item.classList.contains("is-watcher")
        && item.querySelector(".activity-thread-select")?.textContent?.includes(title));
      const watcher = items.findIndex((item) => item.classList.contains("is-watcher"));
      return { parent, watcher };
    }, WATCHED_TITLE);
    expect(order.parent).toBeGreaterThanOrEqual(0);
    expect(order.watcher).toBe(order.parent + 1);
    const parentBox = await watchedRow().boundingBox();
    const watcherBox = await row.locator(".watcher-work-row-title").boundingBox();
    expect(watcherBox!.y).toBeGreaterThanOrEqual(parentBox!.y + parentBox!.height - 1);
    expect(watcherBox!.x).toBeGreaterThan(parentBox!.x);
    await watchedRow().focus();
    await app.page.keyboard.press("ArrowDown");
    await expect(row.getByRole("button")).toBeFocused();
    await capture(info, "work-tab-nested-light");
    await app.page.keyboard.press("Shift+F10");
    const actions = app.page.getByRole("menu", { name: /^Thread actions for Watcher · Reviewer/u });
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    await row.getByRole("button").focus();
    await app.page.keyboard.press("ArrowUp");
    await expect(watchedRow()).toBeFocused();
    expect(app.rendererErrors).toEqual([]);
  });

  test("collapses and reopens the dock from the keyboard without a detail subscription", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    const watcherId = await watcherConversationId();
    const subscribed = (): string[] => sentFrames.filter((frame) =>
      (frame.includes('"conversation.detail.subscription"') || frame.includes('"conversation.detail.load"'))
      && frame.includes(watcherId));
    expect(sentFrames.length).toBeGreaterThan(0);
    expect(subscribed()).toEqual([]);

    await dock().getByRole("heading", { level: 2 }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".watcher-dock-frame")).toBeHidden();
    await expect(handle()).toBeFocused();
    await expect(handle()).toHaveAttribute("aria-expanded", "false");
    await expect(handle()).toHaveAccessibleName("Open watcher");
    await capture(info, "dock-handle-light");

    await page.keyboard.press("Enter");
    await expect(dock()).toBeVisible();
    await expect(handle()).toHaveCount(0);
    await expect(dock().getByRole("heading", { level: 2 })).toBeFocused();
    await expect(dock().getByRole("article", { name: FINDING })).toBeVisible();
    expect(subscribed()).toEqual([]);

    await dock().getByRole("button", { name: "Check now" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".watcher-dock-frame")).toBeHidden();
    await expect(handle()).toBeFocused();
    await page.keyboard.press(" ");
    await expect(dock()).toBeVisible();
    expect(subscribed()).toEqual([]);
    expect(app.rendererErrors).toEqual([]);
  });

  test("reviews the last turn without spending one of the turn's checks", async ({ browserName: _browserName }) => {
    const page = app.page;
    const checksLeft = /^\d+ of 30 checks left this turn$/u;
    const before = await readMenuNote(checksLeft);
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    await page.getByRole("menu", { name: "More watcher actions" }).getByRole("menuitem", { name: "Review the last turn" }).click();
    await expect(phase()).toHaveAttribute("data-phase", "waking");
    await queueWatcherReply("SILENT");
    await expect(feedEntries().nth(0).locator("summary")).toHaveText(/^Checked 3 times · .+ · nothing to report/u);
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");
    await expect(dock().locator(".watcher-dock-error")).toHaveCount(0);
    expect(await readMenuNote(checksLeft)).toBe(before);
    expect(app.rendererErrors).toEqual([]);
  });

  test("sends a finding to the main chat on its own once automatic sending is on", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    const menu = page.getByRole("menu", { name: "More watcher actions" });
    const toggle = menu.getByRole("menuitemcheckbox", { name: "Send findings automatically" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await capture(info, "dock-menu-light");
    await toggle.click();
    await expect(menu).toHaveCount(0);
    await expect(phase()).toHaveText(/ · Reviewer · Sends findings automatically$/u);
    await capture(info, "dock-auto-send-light");

    await queueWatcherReply(AUTO_FINDING);
    await queueWatcherReply("SILENT");
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(FOLLOW_UP);
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(FOLLOW_UP, { exact: true }).first()).toBeVisible();

    const card = dock().getByRole("article", { name: AUTO_FINDING });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await expect(card.locator(".watcher-finding-status")).toHaveText(/^Sent \d{1,2}:\d{2}\s[AP]M · automatically · started the main chat's next turn$/u);
    await expect(page.getByRole("separator", { name: /^Note from watcher · Reviewer · /u })).toHaveCount(2);
    await expect(page.getByLabel("Note from watcher", { exact: true })).toHaveCount(2);
    const autoNote = page.getByLabel("Note from watcher", { exact: true }).last();
    await expect(autoNote).toContainText(AUTO_FINDING);
    await expect(page.getByText(NOTE_ANSWER, { exact: true })).toHaveCount(2);
    const autoCheck = Number((await card.locator(".watcher-finding-meta").textContent())?.match(/^Check (\d+)/u)?.[1]);
    await expect.poll(() => dock().locator(".watcher-check-title").evaluateAll((titles, label) => titles.filter((title) =>
      (title.textContent ?? "").replace(title.querySelector("time")?.textContent ?? "", "").trim() === label).length,
    `Check ${autoCheck + 1} ·`)).toBe(1);
    await expect(phase()).not.toHaveAttribute("data-phase", "waking");
    await expect(composer.getByRole("button", { name: /^Stop/u })).toHaveCount(0);
    await expect(page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    await autoNote.locator(".message-watcher-origin").hover();
    await expect(page.locator('[role="tooltip"]')).toHaveText(/^Sent automatically by the watcher \(Reviewer · .+\)$/u);
    await capture(info, "dock-auto-sent-light");

    await dock().getByRole("button", { name: "More watcher actions" }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(phase()).toHaveText(/ · Reviewer · Watching$/u);
    expect(app.rendererErrors).toEqual([]);
  });

  test("opens as a sheet between the chat and an open right panel", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    const tools = await ensureWorkspaceTools(page);
    await selectWorkspaceTool(tools, "Changes");
    await expect(tools.locator(".loading-mark")).toHaveCount(0);
    await capture(info, "compare-changes-light");
    const frame = page.locator(".watcher-dock-frame");
    await expect(frame).toHaveAttribute("data-presentation", "sheet");
    const toolsTop = (await tools.boundingBox())!.y;
    await handle().click();
    await expect(dock()).toBeVisible();
    await expect.poll(async () => {
      const dockBox = await dock().boundingBox();
      const toolsBox = await tools.boundingBox();
      return dockBox && toolsBox ? Math.round(toolsBox.x - (dockBox.x + dockBox.width)) : null;
    }).toBeGreaterThanOrEqual(-1);
    expect((await tools.boundingBox())!.y).toBe(toolsTop);
    const header = await page.locator(".workspace-header").boundingBox();
    expect((await dock().boundingBox())!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
    const topmost = await dock().evaluate((aside) => {
      const box = aside.getBoundingClientRect();
      return aside.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(topmost).toBe(true);
    await capture(info, "dock-beside-panel-light");
    const composer = page.locator(".workspace-chat-column .composer-region");
    const composerTop = (await composer.boundingBox())!.y;
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.locator(".workspace-chat-column > .terminal-dock")).toBeVisible();
    await expect.poll(async () => (await composer.boundingBox())!.y).toBeLessThan(composerTop);
    await expect(dock()).toBeVisible();
    await expect.poll(async () => {
      const dockBox = await dock().boundingBox();
      const composerBox = await composer.boundingBox();
      return dockBox && composerBox ? dockBox.y + dockBox.height - composerBox.y : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    await page.locator("[data-panel-layout-controls]").getByRole("button", { name: /^Toggle terminal/u }).click();
    await expect(page.locator(".workspace-chat-column > .terminal-dock")).toBeHidden();
    await selectWorkspaceTool(tools, "Background tasks");
    await expect(tools.locator(".loading-mark")).toHaveCount(0);
    await capture(info, "compare-background-tasks-light");
    await closeWorkspaceTools(page);
    await expect(dock()).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  });

  test("keeps the dock usable beside four split panes", async ({ browserName: _browserName }, info) => {
    const page = app.page;
    for (const title of SPLIT_TITLES) {
      await sidebar().locator("button.activity-thread-select").filter({ hasText: title }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add this chat to split view" }).click();
      await expect(page.getByRole("region", { name: new RegExp(`· ${title}$`, "u") })).toBeVisible();
    }
    const split = page.getByRole("main", { name: "Split conversation workspace" });
    await expect(split).toBeVisible();
    await expect(split.getByRole("region", { name: /^(Primary|Second|Third|Fourth) chat: /u })).toHaveCount(4);
    await expect(page.getByRole("region", { name: `Primary chat: Inertia · ${WATCHED_TITLE}` })).toBeVisible();

    const frame = page.locator(".watcher-dock-frame");
    await expect(frame).toHaveAttribute("data-presentation", "sheet");
    await expect(frame).toBeHidden();
    await expect(handle()).toHaveAttribute("aria-expanded", "false");
    await handle().click();
    await expect(dock()).toBeVisible();
    await expect(page.locator(".watcher-dock-scrim")).toBeVisible();
    await expect(dock().getByRole("heading", { level: 2 })).toHaveText(`Watching ${WATCHED_TITLE}`);
    await expect(dock().getByRole("article", { name: FINDING })).toBeVisible();
    const pane = page.getByRole("region", { name: `Primary chat: Inertia · ${WATCHED_TITLE}` });
    const paneBox = await pane.boundingBox();
    await expect.poll(async () => (await dock().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(280);
    await expect.poll(async () => {
      const box = await dock().boundingBox();
      return box ? box.x + box.width : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(paneBox!.x + paneBox!.width + 1);
    const dockBox = await dock().boundingBox();
    expect(dockBox!.x).toBeGreaterThanOrEqual(paneBox!.x);
    const paneComposer = pane.getByRole("textbox", { name: "Message" });
    const composerBox = await pane.locator(".composer-region").boundingBox();
    expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
    await expect(paneComposer).toBeVisible();
    await app.expectNoViewportOverflow();
    await capture(info, "split-panes-with-dock-light");

    await paneComposer.click();
    await expect(frame).toBeHidden();
    await expect(paneComposer).toBeFocused();
    await handle().click();
    await expect(dock()).toBeVisible();
    await dock().getByRole("button", { name: "More watcher actions" }).click();
    await page.getByRole("menu", { name: "More watcher actions" }).getByRole("menuitem", { name: "Collapse", exact: true }).click();
    await expect(page.locator(".watcher-dock-frame")).toBeHidden();
    await expect(handle()).toBeFocused();
    await handle().click();
    await expect(dock()).toBeVisible();
    await expect(split.getByRole("region", { name: /^(Primary|Second|Third|Fourth) chat: /u })).toHaveCount(4);
    expect(app.rendererErrors).toEqual([]);
  });
});
