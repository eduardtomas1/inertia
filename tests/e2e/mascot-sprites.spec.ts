// @inertia-e2e-resource isolated
import { createCanvas } from "@napi-rs/canvas";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MASCOT_SPRITE_STATES, type MascotSpriteState } from "../../src/shared/mascot";
import { createAppFixture } from "./support/app-fixture";

const ACCENTS: Record<MascotSpriteState, string> = {
  idle: "#8cb7af", thinking: "#a4b1bd", working: "#f5ce69", idea: "#fff1ae", pickup: "#e39b8f",
};

function sprite(state: MascotSpriteState, animation = false): Buffer {
  const canvas = createCanvas(96, 96);
  const context = canvas.getContext("2d");
  const cell = (x: number, y: number, width: number, height: number, color: string): void => {
    context.fillStyle = color;
    context.fillRect(x * 6, y * 6, width * 6, height * 6);
  };
  cell(4, 4, 2, 3, "#293442");
  cell(10, 4, 2, 3, "#293442");
  cell(4, 6, 8, 8, "#293442");
  cell(5, 7, 6, 6, ACCENTS[state]);
  cell(6, 9, 1, 1, "#151e2b");
  cell(9, 9, 1, 1, "#151e2b");
  cell(7, 11, 2, 1, "#151e2b");
  if (state === "thinking") { cell(12, 3, 1, 1, "#f1f2e9"); cell(13, 1, 2, 2, "#f1f2e9"); }
  if (state === "idea") { cell(7, 0, 2, 2, "#f5ce69"); cell(7, 2, 2, 1, "#b68e42"); }
  if (state === "working") cell(3, 13, 10, 2, "#748594");
  if (state === "pickup") { cell(2, 5, 2, 2, ACCENTS[state]); cell(12, 5, 2, 2, ACCENTS[state]); }
  return animation ? canvas.toBuffer("image/webp") : canvas.toBuffer("image/png");
}

async function loaded(page: Page, selector: string): Promise<void> {
  await expect.poll(() => page.locator(selector).evaluateAll((images) => images.length > 0 && images.every((image) =>
    image instanceof HTMLImageElement && image.complete && image.naturalWidth === 96))).toBe(true);
}

test("custom mascot sprites export a template, preview, apply to the overlay, persist and reset", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  const app = await createAppFixture({
    name: "mascot-sprites", initialState: "conversation",
    beforeLaunch: async ({ testDirectory }) => {
      await mkdir(join(testDirectory, "electron-profile"), { recursive: true });
      await writeFile(join(testDirectory, "electron-profile", "mascot-window-state.json"), JSON.stringify({ preferences: { enabled: true, motion: true }, position: null }));
    },
  });
  try {
    await app.resizeWindow(1280, 900);
    const mascotWindow = async (): Promise<Page> => app.electronApp.windows().find((page) => page.url().endsWith("/mascot.html"))
      ?? await app.electronApp.waitForEvent("window", (page) => page.url().endsWith("/mascot.html"));
    let overlay = await mascotWindow();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-sprites", "default");
    const openSettings = async (): Promise<void> => {
      await app.page.getByRole("button", { name: "Settings", exact: true }).click();
      await app.page.getByRole("button", { name: "General", exact: true }).click();
    };
    await openSettings();
    const section = app.page.getByRole("region", { name: "Custom sprites" });
    const templateDirectory = join(app.testDirectory, "Inertia mascot sprites");
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showSaveDialog", async () => ({ canceled: false, filePath: path }));
    }, templateDirectory);
    await section.getByRole("button", { name: "Export template" }).click();
    await expect(section.getByText("Template exported. Replace its PNG files, then import the folder.")).toBeVisible();
    expect(JSON.parse(await readFile(join(templateDirectory, "template.json"), "utf8"))).toMatchObject({ requiredImages: 5, width: 96, height: 96 });
    expect((await readdir(templateDirectory)).sort()).toEqual(["README.txt", "idea.png", "idle.png", "pickup.png", "template.json", "thinking.png", "working.png"]);

    for (const state of MASCOT_SPRITE_STATES.filter((candidate) => candidate !== "idea")) await writeFile(join(templateDirectory, `${state}.png`), sprite(state));
    await writeFile(join(templateDirectory, "working.webp"), sprite("working", true));
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path] }));
    }, templateDirectory);
    await section.getByRole("button", { name: "Import sprites" }).click();
    const preview = section.getByRole("list", { name: "Sprite preview" });
    await expect(preview.getByRole("listitem")).toHaveCount(5);
    await expect(section).toContainText("Preview: 5 stills and 1 animation. Apply to use them.");
    await loaded(app.page, ".mascot-sprite-preview img");
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-sprites", "default");
    for (const appearance of ["light", "dark"] as const) {
      await app.page.getByRole("radio", { name: appearance === "light" ? "Light" : "Dark", exact: true }).click();
      await expect(app.page.locator("html")).toHaveAttribute("data-theme", appearance);
      await section.scrollIntoViewIfNeeded();
      const path = info.outputPath(`mascot-sprites-settings-${appearance}.png`);
      await app.page.locator(".mascot-settings").screenshot({ path });
      await info.attach(`Custom sprite settings ${appearance}`, { path, contentType: "image/png" });
    }

    await section.getByRole("button", { name: "Apply sprites" }).click();
    await expect(section.getByText("Custom sprites applied.")).toBeVisible();
    await expect(section.getByRole("list", { name: "Current sprites" })).toBeVisible();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-sprites", "custom");
    await expect(overlay.locator(".mascot-activity")).toHaveAttribute("src", /\/mascot-sprites\/[0-9a-f]{16}\/idle\.png$/u);
    await expect(overlay.locator(".mascot-pickup")).toHaveAttribute("src", /\/mascot-sprites\/[0-9a-f]{16}\/pickup\.png$/u);
    await expect(overlay.locator(".mascot-lift")).toHaveCSS("display", "none");
    await loaded(overlay, ".mascot-activity");
    const overlayPath = info.outputPath("mascot-sprites-overlay.png");
    await overlay.screenshot({ path: overlayPath, omitBackground: true });
    await info.attach("Custom sprite overlay", { path: overlayPath, contentType: "image/png" });
    const stored = join(app.testDirectory, "electron-profile", "mascot-sprites");
    expect((await readdir(stored)).sort()).toEqual(["idea.png", "idle.png", "pickup.png", "thinking.png", "working.png", "working.webp"]);

    await app.restart();
    overlay = await mascotWindow();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-sprites", "custom");
    await loaded(overlay, ".mascot-activity");
    await openSettings();
    const restored = app.page.getByRole("region", { name: "Custom sprites" });
    await expect(restored).toContainText("Using your sprites: 5 stills and 1 animation.");
    await restored.getByRole("button", { name: "Reset to default" }).click();
    await expect(restored.getByText("Default sprites restored.")).toBeVisible();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-sprites", "default");
    await expect(overlay.locator(".mascot-activity")).not.toHaveAttribute("src", /mascot-sprites/u);
    await loaded(overlay, ".mascot-activity");
    await expect(stat(stored)).rejects.toThrow();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
