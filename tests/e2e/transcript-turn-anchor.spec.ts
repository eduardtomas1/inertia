import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

const delayedAnswerGate = "inertia-anchor-answer-ready";

const delayedAnchorAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answerGate = path.join(process.cwd(), ".git", "inertia-anchor-answer-ready");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "anchor-thread";
const turnId = "anchor-turn";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "anchor-fixture" } });
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
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    const sendAnswer = () => {
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: "anchor-answer",
          delta: Array.from({ length: 80 }, (_, index) => "Live anchored answer line " + index + ".").join("\\n\\n"),
        },
      });
      setTimeout(() => send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } },
      }), 100);
    };
    const waitForAnswerGate = () => {
      if (fs.existsSync(answerGate)) {
        sendAnswer();
        return;
      }
      setTimeout(waitForAnswerGate, 25);
    };
    waitForAnswerGate();
  }
});
`;

test("keeps a clamped accepted turn pending until its delayed answer can follow", async () => {
  const fixturePrefix = `anchor-e2e-${randomUUID()}`;
  const app = await createAppFixture({
    name: "turn-anchor",
    initialState: "conversation",
    codexAppServerSource: delayedAnchorAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      store.updateSettings({ autoScrollToFinalAnswer: false });
      const snapshot = store.shellSnapshot();
      const conversationId = snapshot.activeConversationId;
      if (!conversationId) throw new Error("Turn anchor fixture has no conversation.");
      store.updateConversation(conversationId, {
        title: "Accepted turn anchor fixture",
      });
      const baseTime = Date.now() - 60_000;
      for (let index = 0; index < 18; index += 1) {
        const requestedAt = new Date(baseTime + index * 1_000).toISOString();
        const completedAt = new Date(baseTime + index * 1_000 + 500).toISOString();
        const { turn } = store.beginAgentTurn({
          id: `${fixturePrefix}-turn-${index}`,
          conversationId,
          runId: `${fixturePrefix}-run-${index}`,
          content: `Anchor history request ${index}`,
          providerId: "codex",
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          model: "provider-default",
          reasoningEffort: "high",
          interactionMode: "build",
          accessMode: "supervised",
          configurationRevision: 0,
          association: "authoritative",
          requestedAt,
        });
        const answer = store.createMessage(
          conversationId,
          `Anchor history answer ${index}`,
          "assistant",
          [],
          null,
          completedAt,
        );
        store.updateAgentTurnLifecycle(turn.id, {
          status: "completed",
          startedAt: requestedAt,
          completedAt,
          updatedAt: completedAt,
          terminalAssistantMessageId: answer.id,
          terminalReason: "provider-completed",
        });
      }
      store.close();
    },
  });

  try {
    await app.resizeWindow(1440, 920);
    const { page } = app;
    await expect(page.getByRole("heading", {
      name: "Accepted turn anchor fixture",
      level: 1,
    })).toBeVisible();
    const transcript = page.getByLabel("Thread transcript");
    await expect(transcript.getByRole("feed", {
      name: "18 conversation turns",
    })).toBeVisible();
    await page.waitForTimeout(250);
    await transcript.hover({ position: { x: 300, y: 240 } });
    await page.mouse.wheel(0, -4_000);
    await expect(page.getByRole("button", { name: "Jump to latest" }))
      .toBeVisible();

    const request = "Keep this delayed answer anchored.";
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const acceptedRow = page.locator("[data-turn-id]").filter({
      has: page.getByText(request, { exact: true }),
    });
    await expect(acceptedRow).toBeVisible();

    await expect(page.getByRole("button", { name: "Jump to latest" }))
      .toHaveCount(0);
    await expect.poll(() => acceptedRow.evaluate((row) => {
      const transcriptElement = document.querySelector<HTMLElement>(
        ".message-scroll",
      );
      const viewport = transcriptElement?.getBoundingClientRect();
      return transcriptElement && viewport
        ? row.getBoundingClientRect().top - viewport.top > 11
          && transcriptElement.scrollHeight
            - transcriptElement.clientHeight
            - transcriptElement.scrollTop <= 2
        : false;
    })).toBe(true);

    const latestLine = page.getByText(
      "Live anchored answer line 79.",
      { exact: true },
    );
    await expect(latestLine).toHaveCount(0);
    await writeFile(
      join(app.workspaceDirectory, ".git", delayedAnswerGate),
      "ready\n",
      "utf8",
    );
    await expect(latestLine).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => latestLine.evaluate((line) => {
      const viewport = document.querySelector<HTMLElement>(".message-scroll")
        ?.getBoundingClientRect();
      const bounds = line.getBoundingClientRect();
      return Boolean(
        viewport
        && bounds.top >= viewport.top
        && bounds.bottom <= viewport.bottom,
      );
    })).toBe(true);
    await expect(page.getByRole("button", { name: "Jump to latest" }))
      .toHaveCount(0);

    await transcript.hover({ position: { x: 300, y: 240 } });
    await page.mouse.wheel(0, -4_000);
    await expect(page.getByRole("button", { name: "Jump to latest" }))
      .toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("positions a completed answer at the viewport start by default", async () => {
  const app = await createAppFixture({
    name: "completed-answer-anchor",
    initialState: "conversation",
    codexAppServerSource: delayedAnchorAppServer,
  });

  try {
    await app.resizeWindow(1440, 920);
    const { page } = app;
    const composer = page.getByRole("region", { name: "Message composer" });
    const request = "Position this completed answer for reading.";
    // This scenario owns the completed-answer geometry, not the delayed-answer
    // transition covered above. Release the fixture before submission so the
    // renderer observes one deterministic running -> answer -> completed flow.
    await writeFile(
      join(app.workspaceDirectory, ".git", delayedAnswerGate),
      "ready\n",
      "utf8",
    );
    await composer.getByRole("textbox", { name: "Message" })
      .fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();

    const acceptedRow = page.locator("[data-turn-id]").filter({
      has: page.getByText(request, { exact: true }),
    });
    await expect(acceptedRow).toBeVisible();
    const finalAnswer = page.locator(
      '[data-answer-phase="persisted"][aria-label="Final assistant answer"]',
    ).last();
    await expect(finalAnswer).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => finalAnswer.evaluate((answer) => {
      const viewport = answer.closest<HTMLElement>(".message-scroll")
        ?.getBoundingClientRect();
      return viewport
        ? Math.abs(answer.getBoundingClientRect().top - viewport.top - 8)
        : Number.POSITIVE_INFINITY;
    })).toBeLessThanOrEqual(4);
    await expect(page.getByRole("button", { name: "Jump to latest" }))
      .toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
