import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CheckoutFingerprint } from "../../src/server/git/checkout-fingerprint";
import { captureCheckoutFingerprint } from "../../src/server/git/checkout-fingerprint";
import { providerActivityDetailSections } from "../../src/server/provider/activity-detail";
import { watcherActivityMayWrite, watcherAttributionForm } from "../../src/server/runtime/watcher/watcher-checkout-guard";
import { WATCHER_ACCUMULATE_AGE_COOLDOWNS, WATCHER_SETTLE_DELAY_MS } from "../../src/server/runtime/watcher/watcher-wake-scheduler";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  type WatcherFixture,
} from "../support/watcher-runtime-fixture";

const execFileAsync = promisify(execFile);

afterEach(cleanupWatcherFixtures);

let sequence = 0;

function fingerprints(root: () => string, ...states: Array<Record<string, string> | null>) {
  const queue = [...states];
  return async (): Promise<CheckoutFingerprint> => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next === null
      ? { state: "unavailable", reason: "Not a repository." }
      : { state: "captured", root: root(), head: "abc123", branch: "refs/heads/main", entries: new Map(Object.entries(next)) };
  };
}

async function check(
  f: WatcherFixture,
  linkId: string,
  during: (watcherId: string) => void,
  watcherActivity: boolean | { command: string; title?: string } | "edit" = true,
  reply = "SILENT",
) {
  const { watcherConversationId } = f.store.watcherLinks.get(linkId)!;
  f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Read src/a.ts", activityId: `r-${++sequence}` });
  await f.advance(WATCHER_SETTLE_DELAY_MS + WATCHER_ACCUMULATE_AGE_COOLDOWNS * 60_000);
  await vi.waitFor(() => {
    if (!f.provider.runs.has(watcherConversationId)) throw new Error("watcher not running");
  });
  if (watcherActivity) {
    f.provider.emit(watcherConversationId, { type: "activity", kind: "tool", phase: "completed", label: "Read src/a.ts", activityId: `w-${++sequence}` });
  }
  if (typeof watcherActivity === "object") {
    const activityId = `w-${++sequence}`;
    const label = watcherActivity.title ?? "Bash";
    f.provider.emit(watcherConversationId, { type: "activity", kind: "command", phase: "started", label, activityId, detail: providerActivityDetailSections({ command: watcherActivity.command })! });
    f.provider.emit(watcherConversationId, { type: "activity", kind: "command", phase: "completed", label, activityId, detail: providerActivityDetailSections({ output: "src/b.ts | 2 +-" })! });
  }
  if (watcherActivity === "edit") {
    f.provider.emit(watcherConversationId, { type: "activity", kind: "tool", phase: "started", label: "Edit", detail: "src/a.ts", activityId: `w-${++sequence}` });
  }
  during(watcherConversationId);
  if (f.provider.runs.has(watcherConversationId)) await f.finishTurn(watcherConversationId, reply);
  else await f.flush();
  return f.watchers.coordinator.feed(linkId).items[0]!;
}

describe("watcher checkout guard", () => {
  it("classifies the command each harness records in the activity detail, not its title", () => {
    const context = { cwd: "/repo", windows: false };
    const command = (title: string, detail: string | null) => watcherActivityMayWrite({ kind: "command", title, detail }, context);
    const shown = (text: string, output = "M src/a.ts") => `${providerActivityDetailSections({ command: text })}\n\n${providerActivityDetailSections({ output })}`;
    expect(command("Bash", shown("git diff --stat"))).toBe(false);
    expect(command("Command", shown("git status --short"))).toBe(false);
    expect(command("Interrupted · Command", providerActivityDetailSections({ command: "rg parse src" }))).toBe(false);
    expect(command("Bash", shown("cat src/a.ts > src/b.ts"))).toBe(true);
    expect(command("Bash", shown("git status\nrm -rf src"))).toBe(true);
    expect(command("Bash", null)).toBe(true);
    expect(command("Command", providerActivityDetailSections({ output: "git diff --stat" }))).toBe(true);
    expect(command("git diff --stat", null)).toBe(false);
  });

  it("treats a change another turn on the checkout reported as explained", async () => {
    let root = "";
    const f = await createWatcherFixture({ captureFingerprint: fingerprints(() => root, { "src/a.ts": "1" }, { "src/a.ts": "2" }) });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => {
        f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Edit", detail: "src/a.ts", activityId: `e-${++sequence}` });
      });
      expect(item).toMatchObject({ outcome: "silent", guardState: "clean", guardPaths: [] });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
    } finally {
      await f.close();
    }
  });

  it.each([
    ["darwin", "Src/App.tsx", "src/App.tsx", "clean"],
    ["win32", "SRC\\APP.TSX", "src/App.tsx", "clean"],
    ["darwin", "src/Cafe\u0301.ts", "src/Caf\u00e9.ts", "clean"],
    ["linux", "src/Cafe\u0301.ts", "src/Caf\u00e9.ts", "clean"],
    ["linux", "Src/App.tsx", "src/App.tsx", "changed"],
  ] as const)("on %s, attributes %s reported by another turn to Git's %s: %s", async (platform, reported, changed, state) => {
    let root = "";
    const f = await createWatcherFixture({ platform, captureFingerprint: fingerprints(() => root, {}, { [changed]: "1" }) });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => {
        f.provider.emit(f.watched.id, { type: "activity", kind: "tool", phase: "completed", label: "Edit", detail: reported, activityId: `e-${++sequence}` });
      }, { command: "npm run format" });
      expect(item.guardState).toBe(state);
      expect(f.store.watcherLinks.get(link.id)!.status).toBe(state === "clean" ? "watching" : "paused");
    } finally {
      await f.close();
    }
  });

  it("compares paths in NFC everywhere and folds case only on case-insensitive platforms", () => {
    expect(watcherAttributionForm("Src\\Cafe\u0301.ts", "darwin")).toBe("src/caf\u00e9.ts");
    expect(watcherAttributionForm("Src\\Cafe\u0301.ts", "win32")).toBe("src/caf\u00e9.ts");
    expect(watcherAttributionForm("Src\\Cafe\u0301.ts", "linux")).toBe("Src/Caf\u00e9.ts");
  });

  it("marks the window inconclusive when another turn ran a command, without pausing", async () => {
    let root = "";
    const f = await createWatcherFixture({ captureFingerprint: fingerprints(() => root, {}, { "src/b.ts": "1" }) });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => {
        f.provider.emit(f.watched.id, { type: "activity", kind: "command", phase: "completed", label: "npm run format", activityId: `c-${++sequence}` });
      });
      expect(item).toMatchObject({ outcome: "silent", guardState: "inconclusive", guardPaths: ["src/b.ts"] });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
    } finally {
      await f.close();
    }
  });

  it("pauses with write-detected and lists unexplained paths", async () => {
    let root = "";
    const f = await createWatcherFixture({
      captureFingerprint: fingerprints(() => root, { "src/a.ts": "1" }, { "src/a.ts": "1", "src/new.ts": "2", "docs/x.md": "3" }),
    });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => undefined, { command: "npm run format" });
      expect(item).toMatchObject({ outcome: "write-detected", guardState: "changed" });
      expect([...item.guardPaths].sort()).toEqual(["docs/x.md", "src/new.ts"]);
      const paused = f.store.watcherLinks.get(link.id)!;
      expect(paused).toMatchObject({ status: "paused", pauseReason: "write-detected" });
      expect(paused.pauseDetail).toContain("src/new.ts");
      expect(paused.pauseDetail).toContain("docs/x.md");
    } finally {
      await f.close();
    }
  });

  it("keeps the finding and keeps watching when files change outside Inertia during a check that only read", async () => {
    let root = "";
    const f = await createWatcherFixture({
      captureFingerprint: fingerprints(() => root, { "src/b.ts": "1" }, { "src/b.ts": "2", "src/new.ts": "3" }),
    });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => undefined, true, "The parser drops empty tokens.");
      expect(item).toMatchObject({ outcome: "finding", finding: "The parser drops empty tokens.", guardState: "inconclusive" });
      expect([...item.guardPaths].sort()).toEqual(["src/b.ts", "src/new.ts"]);
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", pauseReason: null });
    } finally {
      await f.close();
    }
  });

  it("keeps watching when files change during a check whose own commands were all read-only", async () => {
    let root = "";
    const f = await createWatcherFixture({
      captureFingerprint: fingerprints(
        () => root,
        { "src/b.ts": "1" }, { "src/b.ts": "2" }, { "src/b.ts": "2" }, { "src/b.ts": "3" }, { "src/b.ts": "3" }, { "src/b.ts": "4" },
      ),
    });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const read = await check(f, link.id, () => undefined, { command: "git diff --stat" }, "The parser drops empty tokens.");
      expect(read).toMatchObject({ outcome: "finding", guardState: "inconclusive", guardPaths: ["src/b.ts"] });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", pauseReason: null });
      const codex = await check(f, link.id, () => undefined, { command: "git status --short", title: "Command" }, "The lexer drops tabs.");
      expect(codex).toMatchObject({ outcome: "finding", guardState: "inconclusive", guardPaths: ["src/b.ts"] });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "watching", pauseReason: null });
      const unknown = await check(f, link.id, () => undefined, { command: "cat src/a.ts > src/b.ts" });
      expect(unknown).toMatchObject({ outcome: "write-detected", guardState: "changed" });
    } finally {
      await f.close();
    }
  });

  it("pauses with write-detected when the watcher's own turn started an edit and files changed", async () => {
    let root = "";
    const f = await createWatcherFixture({ captureFingerprint: fingerprints(() => root, {}, { "src/b.ts": "1" }) });
    root = f.workspace;
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      const item = await check(f, link.id, () => undefined, "edit");
      expect(item).toMatchObject({ outcome: "write-detected", guardState: "changed", guardPaths: ["src/b.ts"] });
      expect(f.store.watcherLinks.get(link.id)).toMatchObject({ status: "paused", pauseReason: "write-detected" });
    } finally {
      await f.close();
    }
  });

  it("reports unavailable outside a repository and skipped when the check did nothing", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach();
      await f.startWatchedTurn();
      expect(await check(f, link.id, () => undefined)).toMatchObject({ guardState: "unavailable", outcome: "silent" });
      expect(await check(f, link.id, () => undefined, false)).toMatchObject({ guardState: "skipped", outcome: "silent" });
      expect(f.store.watcherLinks.get(link.id)!.status).toBe("watching");
    } finally {
      await f.close();
    }
  });

  it("fingerprints a real repository without writing to it", async () => {
    const f = await createWatcherFixture({ captureFingerprint: captureCheckoutFingerprint });
    try {
      await execFileAsync("git", ["init", "-q", "-b", "main", f.workspace]);
      await writeFile(join(f.workspace, "a.txt"), "one\n");
      await execFileAsync("git", ["-C", f.workspace, "add", "a.txt"]);
      await execFileAsync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init"]);
      await writeFile(join(f.workspace, "a.txt"), "two\n");
      const index = await stat(join(f.workspace, ".git", "index"));
      const refs = await readFile(join(f.workspace, ".git", "HEAD"), "utf8");
      const link = await f.attach();
      await f.startWatchedTurn();
      expect(await check(f, link.id, () => undefined)).toMatchObject({ guardState: "clean", outcome: "silent" });
      expect((await stat(join(f.workspace, ".git", "index"))).mtimeMs).toBe(index.mtimeMs);
      expect(await readFile(join(f.workspace, ".git", "HEAD"), "utf8")).toBe(refs);
      expect((await execFileAsync("git", ["-C", f.workspace, "for-each-ref"])).stdout).not.toContain("inertia");
    } finally {
      await f.close();
    }
  });
});
