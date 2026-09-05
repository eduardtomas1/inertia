import { expect, test, type TestInfo } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const primarySessionId = "11111111-1111-4111-8111-111111111111";
const handoffSessionId = "22222222-2222-4222-8222-222222222222";

const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
setInterval(() => {}, 1000);
`;

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "composer-commands",
    initialState: "conversation",
    codexAppServerSource,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const snapshot = store.shellSnapshot();
      const project = snapshot.projects[0]!;
      const primary = snapshot.conversations[0]!;
      const handoff = store.createConversation(project.id, "Release notes handoff");
      const selection = providerNativeModelSelection({ providerId: "codex" });
      const identity = continuationIdentityForSelection(selection, null, false);
      store.updateConversation(primary.id, {
        title: "Composer command polish",
        modelSelection: selection,
        continuationIdentity: identity,
        providerSessionId: primarySessionId,
      });
      store.updateConversation(handoff.id, {
        modelSelection: selection,
        continuationIdentity: identity,
        providerSessionId: handoffSessionId,
      });
      store.updateSettings({ theme: "dark" });
      store.selectConversation(primary.id);
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

async function capture(
  testInfo: TestInfo,
  name: "t3code-command-palette" | "t3code-resume-picker",
): Promise<void> {
  const artifact = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    path: artifact,
    animations: "disabled",
  });
  await testInfo.attach(name, { path: artifact, contentType: "image/png" });
  if (process.env.INERTIA_CAPTURE_PR_ASSETS === "1") {
    await page.screenshot({
      path: join(process.cwd(), "docs", "screenshots", `${name}.png`),
      animations: "disabled",
    });
  }
}

test("keeps provider commands in a full-width floating command surface", async (
  { browserName: _browserName },
  testInfo,
) => {
  await app.resizeWindow(1440, 920);
  const composer = page.locator(".composer");
  const input = page.getByRole("textbox", { name: "Message" });

  await page.mouse.move(1, 1);
  await input.fill("/");
  await expect(composer.getByRole("button", { name: "Send message" }))
    .toBeEnabled();
  const commandList = page.getByRole("listbox", { name: "Composer commands" });
  const commandMenu = page.locator(".composer-command-menu");
  await expect(commandList).toBeVisible();
  await expect(commandList.getByText("Built-in", { exact: true })).toBeVisible();
  await expect(commandList.getByText("Provider", { exact: true })).toBeVisible();
  await expect(commandList.getByRole("option", { name: /\/resume/u })).toBeVisible();
  await expect(commandList.getByRole("option", { name: /\/compact/u })).toBeVisible();
  await expect(commandList.locator('[aria-selected="true"]')).toHaveCount(1);

  const composerBox = await composer.boundingBox();
  const commandBox = await commandMenu.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(commandBox).not.toBeNull();
  expect(Math.abs(commandBox!.x - composerBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(commandBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);
  expect(composerBox!.y - (commandBox!.y + commandBox!.height))
    .toBeGreaterThanOrEqual(7);
  expect(await commandMenu.evaluate((element) =>
    getComputedStyle(element).borderRadius)).toBe("20px");

  const goalCommand = commandList.getByRole("option", { name: /\/goal/u });
  await expect(goalCommand).toBeEnabled();
  await input.press("Home");
  await expect(goalCommand).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(commandList.getByRole("option", { name: /\/plan/u }))
    .toHaveAttribute("aria-selected", "true");
  await input.press("Home");
  await expect(commandList.getByRole("option", { name: /\/goal/u }))
    .toHaveAttribute("aria-selected", "true");
  await capture(testInfo, "t3code-command-palette");

  await input.fill("/resume");
  await expect(commandList.getByRole("option")).toHaveCount(1);
  await expect(commandList.getByText("Built-in", { exact: true })).toHaveCount(0);
  const composerBeforeResume = await composer.boundingBox();
  expect(composerBeforeResume).not.toBeNull();
  await input.press("Tab");

  const resumeSurface = page.getByRole("region", {
    name: "Resume a provider chat",
  });
  const search = page.getByRole("searchbox", { name: "Search resumable chats" });
  await expect(resumeSurface).toBeVisible();
  await expect(search).toBeFocused();
  await expect(resumeSurface.getByRole("option", {
    name: /Composer command polish/u,
  })).toBeVisible();
  await expect(resumeSurface.getByRole("option", {
    name: /Release notes handoff/u,
  })).toBeVisible();

  const resumeBox = await resumeSurface.boundingBox();
  const composerWithResume = await composer.boundingBox();
  expect(resumeBox).not.toBeNull();
  expect(composerWithResume).not.toBeNull();
  expect(Math.abs(resumeBox!.x - composerWithResume!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(resumeBox!.width - composerWithResume!.width))
    .toBeLessThanOrEqual(2);
  expect(Math.abs(composerWithResume!.height - composerBeforeResume!.height))
    .toBeLessThanOrEqual(1);
  await capture(testInfo, "t3code-resume-picker");

  await search.press("Escape");
  await expect(resumeSurface).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});
