import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "provider-auth",
    initialState: "conversation",
    codexAppServerSource: `
if (process.argv.slice(2)[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
setInterval(() => {}, 1_000);
`,
    claudeAuthSource: `
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
if (args[0] === "login") {
  process.stdout.write("Opening browser to sign in...\\r\\n");
  process.stdout.write("/bin/sh: 1: xdg-open: not found\\r\\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/auth");
  setTimeout(() => {
    process.stdout.write("orize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge\\r\\n");
    process.stdout.write("Paste code here if prompted > ");
  }, 25);
  setInterval(() => {}, 1_000);
}
`,
  });
  electronApp = app.electronApp;
  page = app.page;
  await electronApp.evaluate(({ shell }) => {
    const opened: string[] = [];
    Reflect.set(globalThis, "__inertiaProviderAuthOpened", opened);
    Reflect.set(shell, "openExternal", async (url: string) => {
      opened.push(url);
    });
  });
});

test.afterAll(async () => {
  await app.close();
});

test("hands Claude's PTY OAuth URL to the desktop browser exactly once", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  const claude = page.getByRole("button", { name: "Configure Claude" });
  await expect(claude).toContainText("Sign in required", { timeout: 20_000 });
  await claude.click();
  await page.locator(".provider-settings-editor")
    .getByRole("button", { name: "Connect" })
    .click();

  const dialog = page.getByRole("dialog", { name: "Connect Claude" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    "Sign-in page opened in your browser",
  );
  await expect.poll(async () => await electronApp.evaluate(() =>
    (Reflect.get(globalThis, "__inertiaProviderAuthOpened") as string[]).length,
  )).toBe(1);
  expect(await electronApp.evaluate(() =>
    (Reflect.get(globalThis, "__inertiaProviderAuthOpened") as string[])[0],
  )).toBe(AUTH_URL);
  await dialog.getByRole("button", { name: "Close connection window" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => await electronApp.evaluate(() =>
    (Reflect.get(globalThis, "__inertiaProviderAuthOpened") as string[]).length,
  )).toBe(1);
  expect(app.rendererErrors).toEqual([]);
});
