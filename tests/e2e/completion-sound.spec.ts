// @inertia-e2e-resource isolated
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { createAppFixture } from "./support/app-fixture";

function sineWav(seconds: number, frequency = 880, rate = 22_050): Buffer {
  const samples = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVEfmt ", 8, "latin1");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1");
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const fade = Math.min(1, (samples - index) / (rate * 0.2));
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * 9_000 * fade), 44 + index * 2);
  }
  return bytes;
}

test("configures, imports and plays the sound for finished tasks", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "completion-sound", initialState: "conversation" });
  try {
    await app.resizeWindow(1200, 1000);
    const page = app.page;
    const stored = (): Record<string, unknown> => {
      const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true, fileMustExist: true });
      try {
        const row = database.prepare("SELECT completion_sound_json AS value FROM app_state WHERE id = 1").get() as { value: string };
        return JSON.parse(row.value) as Record<string, unknown>;
      } finally { database.close(); }
    };
    await page.evaluate(() => {
      Reflect.set(window, "__completionSoundStarts", 0);
      for (const prototype of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
        const start = prototype.start as (...args: unknown[]) => void;
        prototype.start = function patched(this: AudioScheduledSourceNode, ...args: unknown[]) {
          Reflect.set(window, "__completionSoundStarts", Number(Reflect.get(window, "__completionSoundStarts")) + 1);
          return start.apply(this, args);
        };
      }
    });
    const starts = (): Promise<number> => page.evaluate(() => Number(Reflect.get(window, "__completionSoundStarts")));

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "General", exact: true }).click();
    const card = page.locator('section[aria-labelledby="notifications-heading"]');
    const toggle = card.getByRole("switch", { name: "Sound when a task ends" });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(card.getByRole("switch", { name: "Desktop notifications" })).toHaveAttribute("aria-checked", "true");
    await expect(card.getByRole("heading", { name: "Notifications", level: 3 })).toBeVisible();
    const capture = async (name: string): Promise<void> => {
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.addStyleTag({ content: "::-webkit-scrollbar { display: none; }" });
      await page.waitForTimeout(250);
      await page.mouse.move(0, 0);
      const frame = await card.boundingBox();
      if (!frame) throw new Error("The notification settings are not visible.");
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, animations: "disabled", clip: {
        x: frame.x - 6, y: frame.y - 18, width: frame.width + 12, height: frame.height + 36,
      } });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    const importClip = async (file: string, seconds: number, frequency: number, name: string): Promise<void> => {
      const clip = join(app.testDirectory, file);
      await writeFile(clip, sineWav(seconds, frequency));
      await app.electronApp.evaluate(({ dialog }, path) => {
        Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
      }, clip);
      const before = await starts();
      await card.getByRole("button", { name: "Import sound…" }).click();
      const input = card.getByRole("textbox", { name: `Name for ${file.replace(/\.wav$/u, "")}` });
      await expect(input).toBeFocused();
      await expect(card.getByRole("alert")).toHaveCount(0);
      await expect.poll(starts).toBeGreaterThan(before);
      await input.fill(name);
      await input.press("Enter");
      await expect(sounds.getByRole("radio", { name: new RegExp(name, "u") })).toHaveAttribute("aria-checked", "true");
    };

    for (const theme of ["Dark", "Light"] as const) {
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await capture(`completion-sound-off-${theme.toLowerCase()}`);
    }
    await page.getByRole("radio", { name: "Dark", exact: true }).click();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(starts).toBeGreaterThan(0);
    await expect.poll(() => stored().enabled).toBe(true);
    const sounds = card.getByRole("radiogroup", { name: "Sound" });
    await expect(sounds.getByRole("radio")).toHaveCount(6);

    const beforeBell = await starts();
    await sounds.getByRole("radio", { name: /Bell/u }).click();
    await expect(sounds.getByRole("radio", { name: /Bell/u })).toHaveAttribute("aria-checked", "true");
    await expect.poll(starts).toBeGreaterThan(beforeBell);
    await expect.poll(() => stored().sound).toBe("bell");

    await importClip("soft-ding.wav", 1.2, 880, "Soft ding");
    await importClip("long-run.wav", 2.4, 523, "Long run done");
    await expect(sounds.getByRole("radio")).toHaveCount(8);
    await expect.poll(() => (stored().library as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(["Soft ding", "Long run done"]);
    const selected = await starts();
    await card.getByRole("button", { name: "Preview Soft ding" }).click();
    await expect.poll(starts).toBeGreaterThan(selected);

    await card.getByRole("switch", { name: "Only after long tasks" }).click();
    const durations = card.getByRole("radiogroup", { name: "Long task duration" });
    await durations.getByRole("radio", { name: "5 min", exact: true }).click();
    await expect(durations.getByRole("radio", { name: "5 min", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => [stored().longRunsOnly, stored().longRunSeconds]).toEqual([true, 300]);

    for (const theme of ["Dark", "Light"] as const) {
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await capture(`completion-sound-on-${theme.toLowerCase()}`);
    }

    await card.getByRole("button", { name: "Remove Long run done" }).click();
    await expect(sounds.getByRole("radio", { name: /Chime/u })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => (stored().library as unknown[]).length).toBe(1);
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
