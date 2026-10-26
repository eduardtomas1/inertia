// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

const sourceAnswerGate = "multi-spawn-source-answer-ready";
const judgeAnswerGate = "multi-spawn-judge-answer-ready";
const neighbourAnswerGate = "multi-spawn-neighbour-answer-ready";

const multiSpawnAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "multi-spawn-thread-" + process.pid;
let turnSequence = 0;
let activeTurnId = null;
let responseTimer = null;
let responseSettled = false;
// Provider children intentionally receive an allow-listed environment, so
// test-only Electron variables do not cross that boundary. Both seeded
// project checkouts are direct children of the fixture root.
const dataDirectory = path.resolve(process.cwd(), "..", "data");
const waitForGate = (gate, callback) => {
  const deadlineAt = Date.now() + 30000;
  const inspect = () => {
    if (responseSettled) return;
    if (fs.existsSync(path.join(dataDirectory, gate))) {
      callback();
      return;
    }
    if (Date.now() >= deadlineAt) {
      responseSettled = true;
      send({ method: "turn/completed", params: {
        threadId,
        turn: {
          id: activeTurnId,
          status: "failed",
          items: [],
          error: { message: "Multi-spawn fixture response gate timed out." },
        },
      } });
      return;
    }
    responseTimer = setTimeout(inspect, 20);
  };
  inspect();
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "multi-spawn-fixture" } });
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
    if (responseSettled || !activeTurnId) return;
    responseSettled = true;
    if (responseTimer) clearTimeout(responseTimer);
    send({ method: "turn/completed", params: {
      threadId,
      turn: {
        id: activeTurnId,
        status: "interrupted",
        items: [],
        error: null,
      },
    } });
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const turnId = "multi-spawn-turn-" + turnSequence;
  activeTurnId = turnId;
  responseSettled = false;
  send({ id: message.id, result: {
    turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  send({ method: "turn/started", params: {
    threadId, turn: { id: turnId, status: "inProgress", items: [], error: null },
  } });
  const inputText = (message.params.input || [])
    .filter((item) => item && item.type === "text")
    .map((item) => item.text || "")
    .join("\\n");
  const isJudge = inputText.includes("# Independent Duo comparison");
  const isNeighbour = inputText.includes("Stay busy in this folder");
  const answer = isJudge
    ? "Multi-spawn judge response from " + path.basename(process.cwd()) + "."
    : "Multi-spawn source response from " + path.basename(process.cwd()) + ".";
  waitForGate(
    isJudge
      ? "${judgeAnswerGate}"
      : isNeighbour ? "${neighbourAnswerGate}" : "${sourceAnswerGate}",
    () => {
      if (responseSettled) return;
      responseSettled = true;
      send({ method: "item/agentMessage/delta", params: {
        threadId, turnId, itemId: "multi-spawn-answer-" + turnId,
        delta: answer,
      } });
      send({ method: "turn/completed", params: {
        threadId,
        turn: { id: turnId, status: "completed", items: [], error: null },
      } });
    },
  );
});
`;

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "multi-spawn",
    initialState: "conversation",
    seedSecondProject: true,
    codexAppServerSource: multiSpawnAppServer,
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("launches two truthful routes and locks a bounded third-model judge", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1320, 900);
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  await sidebar.getByRole("button", { name: "New duo" }).click();

  const dialog = page.getByRole("dialog", {
    name: "New duo",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Ready", { exact: true })).toHaveCount(2);
  await dialog.getByRole("textbox", { name: "Brief for both chats" })
    .fill("Compare the lifecycle and propose the safest implementation.");
  await dialog.getByRole("textbox", { name: "Chat A name" })
    .fill("Lifecycle review");
  await dialog.getByRole("textbox", { name: "Chat B name" })
    .fill("Independent review");
  await dialog.getByRole("combobox", { name: "Chat B project" })
    .selectOption({ label: "Companion" });
  await dialog.getByRole("combobox", { name: "Chat B access" })
    .selectOption("full");
  const settledTop = async (): Promise<number> => {
    await dialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)));
    });
    return (await dialog.boundingBox())!.y;
  };
  const anchoredTop = await settledTop();
  expect(anchoredTop).toBeGreaterThanOrEqual(40);
  expect(anchoredTop).toBeLessThanOrEqual(72);
  await dialog.getByRole("switch", { name: "Add an independent judge" })
    .click();
  const judgeConfiguration = dialog.locator(".multi-spawn-judge-config");
  await expect(judgeConfiguration).not.toHaveAttribute("open", "");
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  expect(Math.abs(await settledTop() - anchoredTop)).toBeLessThan(2);
  await dialog.getByRole("textbox", { name: "Judge name" })
    .fill("Independent judge");
  await dialog.getByRole("combobox", { name: "Judge project" })
    .selectOption({ label: "Companion" });
  await dialog.getByRole("combobox", { name: "Judge access" })
    .selectOption("full");
  await expect(judgeConfiguration).toHaveAttribute("open", "");
  await expect(dialog.getByRole("textbox", { name: "Judge name" }))
    .toBeVisible();
  const sharingDisclosure = dialog.getByText(
    "What is shared with the judge?",
    { exact: true },
  );
  await expect(sharingDisclosure)
    .toBeVisible();
  await expect(dialog.getByText(/It sends no source session/u))
    .not.toBeVisible();
  await sharingDisclosure.click();
  await expect(dialog.getByText(/It sends no source session/u)).toBeVisible();
  await sharingDisclosure.click();
  await expect(dialog.getByText("Judge can edit a source checkout", { exact: true }))
    .toBeVisible();
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  await expect(judgeConfiguration).not.toHaveAttribute("open", "");

  const wideDialogBounds = await dialog.boundingBox();
  expect(wideDialogBounds).not.toBeNull();
  expect(wideDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(wideDialogBounds!.y + wideDialogBounds!.height)
    .toBeLessThanOrEqual(900);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  const lightWide = testInfo.outputPath("multi-spawn-light-wide.png");
  await page.screenshot({
    animations: "disabled",
    path: lightWide,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-light-wide", {
    path: lightWide,
    contentType: "image/png",
  });

  await app.resizeWindow(720, 840);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  await judgeConfiguration.scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "Start duo" }))
    .toBeVisible();
  const routeCards = dialog.locator(".multi-spawn-sides > .multi-spawn-side");
  const routeCardBounds = await routeCards.evaluateAll((cards) => cards.map((card) => {
    const bounds = card.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top };
  }));
  expect(routeCardBounds).toHaveLength(2);
  expect(Math.abs(routeCardBounds[0].left - routeCardBounds[1].left))
    .toBeLessThanOrEqual(1);
  expect(routeCardBounds[0].top).toBeLessThan(routeCardBounds[1].top);
  await expect(dialog.locator(".multi-spawn-preset-toggle small")).toBeHidden();
  await app.expectNoViewportOverflow();
  const darkNarrow = testInfo.outputPath("multi-spawn-dark-narrow.png");
  await page.screenshot({
    animations: "disabled",
    path: darkNarrow,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-dark-narrow", {
    path: darkNarrow,
    contentType: "image/png",
  });

  await app.resizeWindow(1320, 900);
  await dialog.getByRole("button", { name: "Start duo" }).click();

  const split = page.getByRole("main", {
    name: "Split conversation workspace",
  });
  await expect(split).toBeVisible();
  await expect(page.getByRole("region", {
    name: "Primary chat: Inertia · Lifecycle review",
  })).toBeVisible();
  await expect(page.getByRole("region", {
    name: "Second chat: Companion · Independent review",
  })).toBeVisible();
  await expect(
    split.getByText(
      "Compare the lifecycle and propose the safest implementation.",
      { exact: true },
    ),
  ).toHaveCount(2);
  await expect(
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Lifecycle review" }),
  ).toBeVisible();
  await expect(
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Independent review" }),
  ).toBeVisible();
  await expect(
    sidebar.locator("button.activity-thread-select")
      .filter({ hasText: "Independent judge" }),
  ).toBeVisible();
  await writeFile(
    join(app.testDirectory, "data", sourceAnswerGate),
    "ready\n",
    "utf8",
  );
  const primaryAnswers = page.getByRole("region", {
    name: "Primary chat: Inertia · Lifecycle review",
  }).locator(
    '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
  );
  const secondaryAnswers = page.getByRole("region", {
    name: "Second chat: Companion · Independent review",
  }).locator(
    '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
  );
  await expect(primaryAnswers).toContainText(
    "Multi-spawn source response from Inertia.",
  );
  await expect(secondaryAnswers).toContainText(
    "Multi-spawn source response from Companion.",
  );
  const comparingNotices = split.locator(".duo-judge-notice")
    .filter({ hasText: "Judge is comparing both chats" });
  await expect(comparingNotices).toHaveCount(2);
  await expect(comparingNotices.first().getByRole("button", { name: "Open judge" }))
    .toBeEnabled();
  await app.expectNoViewportOverflow();

  const splitResult = testInfo.outputPath("multi-spawn-split-result.png");
  await page.screenshot({
    animations: "disabled",
    path: splitResult,
    scale: "device",
  });
  await testInfo.attach("multi-spawn-split-result", {
    path: splitResult,
    contentType: "image/png",
  });
  await writeFile(
    join(app.testDirectory, "data", judgeAnswerGate),
    "ready\n",
    "utf8",
  );
  const judgeRow = sidebar.locator("button.activity-thread-select")
    .filter({ hasText: "Independent judge" });
  const verdictNotices = split.locator(".duo-judge-notice")
    .filter({ hasText: "Verdict is in" });
  await expect(verdictNotices).toHaveCount(2);
  await expect(split).toBeVisible();
  await expect(judgeRow).not.toHaveAttribute("aria-current", "page");
  await verdictNotices.first().getByRole("button", { name: "Read verdict" }).click();
  await expect(judgeRow).toHaveAttribute("aria-current", "page");
  await expect(split).toBeHidden();
  const judgeAnswer = page.locator(
    '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
  ).filter({ hasText: "Multi-spawn judge response from Companion." });
  await expect(judgeAnswer).toBeVisible();
  const judgeTurn = page.locator(".response-turn").filter({ has: judgeAnswer });
  await expect(judgeTurn.locator('[data-turn-status="completed"]'))
    .toBeVisible();
  const comparison = judgeTurn.getByRole("article", { name: "Comparing A and B" });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole("listitem")).toHaveCount(2);
  await expect(comparison).not.toContainText("# Independent Duo comparison");
  const fullBrief = comparison.getByRole("button", { name: "Show the full brief" });
  await expect(fullBrief).toHaveAttribute("aria-expanded", "false");
  await fullBrief.click();
  await expect(comparison).toContainText("# Independent Duo comparison");
  expect(app.rendererErrors).toEqual([]);
});

test("starts the judge while another chat is busy in the judge's folder", async () => {
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  const companionRow = sidebar.locator("button.activity-thread-select")
    .filter({ hasText: "multi-spawn companion" });
  await companionRow.click();
  await expect(companionRow).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main", { name: "Split conversation workspace" }))
    .toHaveCount(0);
  const busyBrief = "Stay busy in this folder until the neighbour gate opens.";
  const messageBox = page.getByRole("textbox", { name: "Message" });
  await expect(messageBox).toHaveCount(1);
  await messageBox.fill(busyBrief);
  await expect(messageBox).toHaveValue(busyBrief);
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByRole("button", { name: "Stop agent" }))
    .toBeVisible();

  await sidebar.getByRole("button", { name: "New duo" }).click();
  const dialog = page.getByRole("dialog", { name: "New duo" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Brief for both chats" })
    .fill("Review the folder while a neighbour keeps working.");
  await dialog.getByRole("textbox", { name: "Chat A name" })
    .fill("Neighbour left");
  await dialog.getByRole("textbox", { name: "Chat B name" })
    .fill("Neighbour right");
  await dialog.getByRole("combobox", { name: "Chat B project" })
    .selectOption({ label: "Companion" });
  const judgeSwitch = dialog.getByRole("switch", {
    name: "Add an independent judge",
  });
  if (await judgeSwitch.getAttribute("aria-checked") !== "true") {
    await judgeSwitch.click();
  }
  const judgeConfiguration = dialog.locator(".multi-spawn-judge-config");
  if (await judgeConfiguration.getAttribute("open") === null) {
    await judgeConfiguration.getByText("Configure judge", { exact: true }).click();
  }
  await dialog.getByRole("textbox", { name: "Judge name" })
    .fill("Neighbour judge");
  await dialog.getByRole("combobox", { name: "Judge project" })
    .selectOption({ label: "Companion" });
  await dialog.getByRole("combobox", { name: "Judge access" })
    .selectOption("supervised");
  await dialog.getByRole("button", { name: "Start duo" }).click();

  const judgeRow = sidebar.locator("button.activity-thread-select")
    .filter({ hasText: "Neighbour judge" });
  const verdictNotice = page.locator(".duo-judge-notice")
    .filter({ hasText: "Verdict is in" })
    .first();
  await expect(verdictNotice).toBeVisible();
  await expect(judgeRow).not.toHaveAttribute("aria-current", "page");
  await verdictNotice.getByRole("button", { name: "Read verdict" }).click();
  await expect(judgeRow).toHaveAttribute("aria-current", "page");
  await expect(page.locator(
    '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
  ).filter({ hasText: "Multi-spawn judge response from Companion." }))
    .toBeVisible();
  await expect(page.locator(".duo-judge-notice")).toHaveCount(0);

  await companionRow.click();
  await expect(companionRow).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Stop agent" }))
    .toBeVisible();
  await writeFile(
    join(app.testDirectory, "data", neighbourAnswerGate),
    "ready\n",
    "utf8",
  );
  await expect(page.locator(
    '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
  ).filter({ hasText: "Multi-spawn source response from Companion." }))
    .toBeVisible();
  expect(app.rendererErrors).toEqual([]);
});
