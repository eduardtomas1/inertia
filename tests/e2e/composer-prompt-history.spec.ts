// @inertia-e2e-resource isolated
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture | undefined;
test.afterEach(async () => {
  const owned = app;
  app = undefined;
  await owned?.close();
});

test("keeps native wrapped-line editing and browses history only at text edges", async () => {
  const testInfo = test.info();
  const older = "Review the retry behavior.\nKeep cancellation immediate.";
  const newer = "Cover the update handoff.\nPreserve the existing conversation.";
  app = await createAppFixture({
    name: "composer-prompt-history", initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      const conversation = store.shellSnapshot().conversations[0]!;
      store.createMessage(conversation.id, older, "user", [], null, "2026-09-08T08:00:00.000Z");
      store.createMessage(conversation.id, newer, "user", [], null, "2026-09-08T08:01:00.000Z");
      store.close();
    },
  });
  await app.resizeWindow(1100, 760);
  const { page } = app;
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Keep this unfinished draft while moving between the wrapped lines of the composer. ".repeat(10);
  await input.fill(draft);
  const caret = (): Promise<number> => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart);
  const placeCaret = (position: number): Promise<void> => input.evaluate((element: HTMLTextAreaElement, offset) => {
    element.focus();
    element.setSelectionRange(offset, offset);
  }, position);
  expect(await input.evaluate((element) => element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) * 2)).toBe(true);
  await placeCaret(400);
  await input.press("ArrowUp");
  const previousLine = await caret();
  expect(previousLine).toBeGreaterThan(0);
  expect(previousLine).toBeLessThan(400);
  await expect(input).toHaveValue(draft);
  await input.press("ArrowDown");
  expect(await caret()).toBeGreaterThan(previousLine);
  await expect(input).toHaveValue(draft);
  const screenshot = testInfo.outputPath("composer-wrapped-line-editing.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("Wrapped draft retains native arrow movement", { path: screenshot, contentType: "image/png" });

  await placeCaret(0);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(newer);
  await expect.poll(caret).toBe(0);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(older);
  await expect.poll(caret).toBe(0);
  await input.press("ArrowDown");
  expect(await caret()).toBeGreaterThan(0);
  await expect(input).toHaveValue(older);
  await placeCaret(older.length);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(newer);
  await expect.poll(caret).toBe(newer.length);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(draft);
  await expect.poll(caret).toBe(draft.length);
  expect(app.rendererErrors).toEqual([]);
});
