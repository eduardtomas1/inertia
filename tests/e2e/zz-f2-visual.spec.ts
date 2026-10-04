// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

let app!: AppFixture;
let page!: AppFixture["page"];

const out = process.env.F2_OUT ?? "/private/tmp/claude-501/-Users-eduardtomasvelez-Desktop-inertia/7bc7d733-2d51-4890-8ecc-6c1e38b8533f/scratchpad/f2-visual";

test.beforeAll(async () => {
  app = await createAppFixture({ name: "zz-f2-visual", initialState: "conversation" });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

function nav(name: string) {
  return page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true });
}

async function shot(name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
}

test("captures", async () => {
  test.setTimeout(240_000);
  await app.resizeWindow(1000, 800);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
  const sections = (process.env.F2_SECTIONS ?? "Notifications,Data").split(",");
  for (const scheme of (process.env.F2_SCHEMES ?? "dark,light").split(",")) {
    if (scheme === "forced") await page.emulateMedia({ forcedColors: "active" });
    else {
      await page.emulateMedia({ forcedColors: "none" });
      await setAppearanceInPlace(app, scheme as "dark" | "light");
    }
    for (const section of sections) {
      await nav(section).click();
      await page.waitForTimeout(400);
      await shot(`${section.toLowerCase().replace(/\W+/gu, "-")}-${scheme}`);
      const scroller = page.locator(".settings-content").first();
      const more = await scroller.evaluate((element) => element.scrollHeight > element.clientHeight + 40);
      if (more) {
        await scroller.evaluate((element) => { element.scrollTop = element.clientHeight - 80; });
        await shot(`${section.toLowerCase().replace(/\W+/gu, "-")}-${scheme}-2`);
        await scroller.evaluate((element) => { element.scrollTop = 0; });
      }
    }
  }
});
