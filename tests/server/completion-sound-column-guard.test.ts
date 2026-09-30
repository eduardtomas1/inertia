import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";

vi.mock("../../src/shared/completion-sound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/completion-sound")>();
  return {
    ...actual,
    parseCompletionSoundSettings: (value: Record<string, unknown>) => ({
      ...actual.parseCompletionSoundSettings(value),
      library: value.library,
    }),
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

it("keeps the stored completion sound instead of failing the settings write when it would overflow the column", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inertia-completion-sound-guard-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspacePath);
  const ding = { file: "0123456789abcdef.mp3", name: "Ding" } as const;
  store.updateSettings({ completionSound: { enabled: true, sound: ding.file, library: [ding] } });
  const oversized = Array.from({ length: 8 }, (_, index) => ({
    file: `${index.toString(16).padStart(16, "0")}.wav` as const,
    name: "x".repeat(300),
  }));
  expect(() => store.updateSettings({ desktopNotifications: false, completionSound: { library: oversized } }))
    .not.toThrow();
  const { settings } = store.snapshot();
  expect(settings.desktopNotifications).toBe(false);
  expect(settings.completionSound).toMatchObject({ enabled: true, sound: ding.file, library: [ding] });
  store.close();
});
