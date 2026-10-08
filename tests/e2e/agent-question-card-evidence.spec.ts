// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { capturePageWebSockets, publishCapturedWebSocketEvent } from "./support/browser-websocket-fixture";

const evidenceDirectory = process.env.INERTIA_QUESTION_CARD_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_QUESTION_CARD_EVIDENCE_DIR)
  : null;
const runId = "77777777-7777-4777-8777-777777777777";
const turnId = "88888888-8888-4888-8888-888888888888";
let app!: AppFixture;
let conversationId = "";

test.skip(!evidenceDirectory, "Set INERTIA_QUESTION_CARD_EVIDENCE_DIR to capture question card evidence.");

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-question-card-evidence",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        conversationId = store.snapshot().conversations[0]!.id;
        const selection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-opus-5-5", alias: "Opus 5.5" });
        const requestedAt = new Date(Date.now() - 60_000).toISOString();
        store.updateConversation(conversationId, { providerId: "claude", modelSelection: selection });
        store.beginAgentTurn({
          id: turnId, conversationId, runId, content: "Wire the new sync service into billing.",
          providerId: "claude", modelSelection: selection, reasoningEffort: selection.reasoningEffort ?? "",
          interactionMode: "build", accessMode: "supervised",
          configurationRevision: selection.backendConfigurationRevision, association: "authoritative", requestedAt,
        });
        store.updateAgentTurnLifecycle(turnId, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
        store.updateAgentTurnLifecycle(turnId, { status: "waiting-for-input", updatedAt: requestedAt });
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("captures the question card and its transitions between questions", async () => {
  const directory = evidenceDirectory!;
  const frameDirectory = join(directory, "frames");
  await mkdir(frameDirectory, { recursive: true });
  await app.resizeWindow(1440, 920);
  await capturePageWebSockets(app.page);
  await app.page.reload({ waitUntil: "domcontentloaded" });
  await app.page.locator('.app-shell[data-connection-status="online"]').waitFor();
  await publishCapturedWebSocketEvent(app.page, {
    type: "agent.input.requested",
    request: {
      id: "question-card-evidence",
      providerId: "claude", conversationId, runId, turnId,
      autoResolutionMs: null,
      questions: [
        {
          id: "database", header: "Database", question: "Which database should the sync service write to?",
          isOther: true, isSecret: false, allowMultiple: false,
          options: [
            { id: "postgres", label: "PostgreSQL (Recommended)", description: "Matches the existing billing schema and migration tooling." },
            { id: "sqlite", label: "SQLite", description: "Simplest locally, but no concurrent writers." },
            { id: "dynamo", label: "DynamoDB", description: "Scales well; needs new IAM roles and a table per tenant." },
          ],
        },
        {
          id: "scope", header: "Scope", question: "Which parts should I update in this pass?",
          isOther: false, isSecret: false, allowMultiple: true,
          options: [
            { id: "api", label: "API handlers", description: "Routes under src/api/billing." },
            { id: "jobs", label: "Background jobs", description: "Nightly reconciliation and retry workers." },
            { id: "tests", label: "Tests", description: "" },
            { id: "docs", label: "Docs", description: "" },
          ],
        },
        {
          id: "name", header: "Naming", question: "What should the new service be called?",
          isOther: false, isSecret: false, allowMultiple: false, options: [],
        },
      ],
    },
  });

  const card = app.page.locator('[data-agent-request-state="question"]');
  await expect(card).toContainText("Claude has 3 questions");
  // The seeded turn is reported as interrupted after the fixture relaunches the app; those
  // recovery notices are unrelated to the card, so keep them out of the captures.
  await app.page.addStyleTag({ content: ".turn-failure-diagnostics, .turn-changed-files.is-unavailable { display: none !important; }" });
  await app.page.evaluate(() => {
    const question = document.querySelector('[data-agent-request-state="question"]');
    const stopped = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) =>
      element.textContent?.trim().startsWith("Stopped after")
      && ![...element.children].some((child) => child.textContent?.trim().startsWith("Stopped after")));
    for (const element of stopped) {
      let row = element;
      while (row.parentElement && !row.parentElement.contains(question)) row = row.parentElement;
      row.style.display = "none";
    }
  });
  await card.scrollIntoViewIfNeeded();
  await app.page.waitForTimeout(500);
  const box = (await card.boundingBox())!;
  const margin = 16;
  const clip = { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
  const headroom = 64;
  const setTheme = (theme: "light" | "dark"): Promise<void> =>
    app.page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await app.page.waitForTimeout(300);
    await app.page.screenshot({ path: join(directory, `question-card-${theme}.png`), clip });
  }

  // Record the dark card through the Chromium screencast so transitions keep their real timing.
  const viewport = await app.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  // The timeline keeps its bottom edge anchored, so a shorter question lets earlier content slide in above.
  const motionClip = { ...clip, y: Math.max(0, clip.y - headroom), height: clip.height + Math.min(headroom, clip.y) };
  const session = await app.page.context().newCDPSession(app.page);
  const frames: Array<{ file: string; timestamp: number }> = [];
  const writes: Array<Promise<void>> = [];
  session.on("Page.screencastFrame", (frame) => {
    const file = `frame-${String(frames.length).padStart(4, "0")}.png`;
    frames.push({ file, timestamp: frame.metadata.timestamp ?? Date.now() / 1_000 });
    writes.push(writeFile(join(frameDirectory, file), Buffer.from(frame.data, "base64")));
    void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await app.page.waitForTimeout(1_000);
  await card.getByRole("radio", { name: /PostgreSQL/u }).click();
  await app.page.waitForTimeout(700);
  await card.getByRole("button", { name: "Next" }).click();
  await app.page.waitForTimeout(1_000);
  await card.getByRole("checkbox", { name: /API handlers/u }).click();
  await app.page.waitForTimeout(300);
  await card.getByRole("checkbox", { name: /Tests/u }).click();
  await app.page.waitForTimeout(700);
  await card.getByRole("button", { name: "Next" }).click();
  await app.page.waitForTimeout(800);
  await card.getByRole("textbox", { name: "What should the new service be called?" }).pressSequentially("billing-sync", { delay: 60 });
  await app.page.waitForTimeout(900);
  await card.getByRole("button", { name: "Back" }).click();
  await app.page.waitForTimeout(1_200);
  await session.send("Page.stopScreencast");
  await Promise.all(writes);

  const concat = frames.map(({ file, timestamp }, index) => {
    const next = frames[index + 1]?.timestamp ?? timestamp + 1.5;
    return `file '${join(frameDirectory, file)}'\nduration ${Math.max(0.02, next - timestamp).toFixed(3)}`;
  });
  await writeFile(join(directory, "frames.txt"), `${concat.join("\n")}\nfile '${join(frameDirectory, frames.at(-1)!.file)}'\n`);
  await writeFile(join(directory, "crop.json"), JSON.stringify({
    x: motionClip.x / viewport.width,
    y: motionClip.y / viewport.height,
    width: motionClip.width / viewport.width,
    height: motionClip.height / viewport.height,
  }));
  expect(app.rendererErrors).toEqual([]);
});
