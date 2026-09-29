import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_UPDATE_IPC } from "../../src/main/app-update-ipc";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";
import { DETACHED_CHAT_IPC } from "../../src/shared/detached-chat-ipc";
import { MASCOT_IPC } from "../../src/shared/mascot";

const root = resolve(__dirname, "../..");
const CHANNEL_LITERAL = /["'`](inertia:[a-z-]+)["'`]/gu;
const CHANNEL_ENTRY = /\b(\w+): "(inertia:[a-z-]+)"/gu;

const SELF_CONTAINED_PRELOAD_TABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "src/preload/detached-chat.ts": { ...DESKTOP_IPC, ...DETACHED_CHAT_IPC },
  "src/preload/mascot.ts": MASCOT_IPC,
};
const DECLARING_FILES = new Set([
  "src/main/app-update-ipc.ts",
  ...Object.keys(SELF_CONTAINED_PRELOAD_TABLES),
]);

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

describe("desktop IPC channel names", () => {
  it("keeps the main app update registrations identical to the shared desktop table", () => {
    for (const [key, channel] of Object.entries(APP_UPDATE_IPC)) {
      expect(DESKTOP_IPC[key as keyof typeof DESKTOP_IPC], key).toBe(channel);
    }
  });

  it.each(Object.entries(SELF_CONTAINED_PRELOAD_TABLES))(
    "keeps the self-contained %s table identical to the shared tables",
    (path, shared) => {
      const contents = source(path);
      const literals = [...contents.matchAll(CHANNEL_LITERAL)].map((match) => match[1]);
      const entries = [...contents.matchAll(CHANNEL_ENTRY)].map(([, key, channel]) => [key, channel]);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.map(([, channel]) => channel)).toEqual(literals);
      for (const [key, channel] of entries) {
        expect(shared[key!], `${path} ${key}`).toBe(channel);
      }
    },
  );

  it("declares main and preload channel names only in the channel tables", () => {
    const undeclared = [...sourceFiles("src/main"), ...sourceFiles("src/preload")]
      .filter((path) => !DECLARING_FILES.has(path))
      .flatMap((path) => [...source(path).matchAll(CHANNEL_LITERAL)]
        .map((match) => `${path}: ${match[1]}`));
    expect(undeclared).toEqual([]);
  });
});
