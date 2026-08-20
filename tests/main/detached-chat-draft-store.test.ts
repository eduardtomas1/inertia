import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DetachedChatDraftStore,
  MAX_PENDING_DETACHED_CHAT_DRAFTS,
  parseDetachedChatDraftStore,
} from "../../src/main/detached-chat-draft-store";

const firstConversation = "11111111-1111-4111-8111-111111111111";

const directories: string[] = [];

function statePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "inertia-detached-drafts-"));
  directories.push(directory);
  return {
    directory,
    path: join(directory, "detached-chat-pending-drafts.json"),
  };
}

function conversationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("detached chat draft store", () => {
  it("reloads the exact durable handoff, including an intentionally empty draft", () => {
    const { path } = statePath();
    const pending = new DetachedChatDraftStore(path).put({
      conversationId: firstConversation,
      draft: "",
    });

    expect(new DetachedChatDraftStore(path).snapshot()).toEqual([pending]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      drafts: [pending],
    });
  });

  it.runIf(process.platform !== "win32")(
    "publishes mode 0600 without leaving transaction artifacts",
    () => {
      const { directory, path } = statePath();
      const store = new DetachedChatDraftStore(path);
      store.put({ conversationId: firstConversation, draft: "first" });
      store.put({ conversationId: firstConversation, draft: "second" });

      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory)).toEqual([
        "detached-chat-pending-drafts.json",
      ]);
    },
  );

  it("does not let a stale acknowledgement delete a newer handoff", () => {
    const { path } = statePath();
    const store = new DetachedChatDraftStore(path);
    const stale = store.put({
      conversationId: firstConversation,
      draft: "old text",
    });
    const current = store.put({
      conversationId: firstConversation,
      draft: "new text",
    });

    expect(current.handoffId).not.toBe(stale.handoffId);
    expect(store.acknowledge({
      conversationId: firstConversation,
      handoffId: stale.handoffId,
    })).toBe(false);
    expect(new DetachedChatDraftStore(path).snapshot()).toEqual([current]);

    expect(store.acknowledge({
      conversationId: firstConversation,
      handoffId: current.handoffId,
    })).toBe(true);
    expect(new DetachedChatDraftStore(path).snapshot()).toEqual([]);
  });

  it("keeps the newest 16 worst-case valid drafts within the file budget", () => {
    const { path } = statePath();
    const store = new DetachedChatDraftStore(path);
    const worstCaseDraft = "\u0000".repeat(20_000);

    for (let index = 0; index <= MAX_PENDING_DETACHED_CHAT_DRAFTS; index += 1) {
      store.put({
        conversationId: conversationId(index),
        draft: worstCaseDraft,
      });
    }

    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(MAX_PENDING_DETACHED_CHAT_DRAFTS);
    expect(snapshot.map((draft) => draft.conversationId)).toEqual(
      Array.from(
        { length: MAX_PENDING_DETACHED_CHAT_DRAFTS },
        (_, index) => conversationId(index + 1),
      ),
    );
    expect(snapshot.every((draft) => draft.draft.length === 20_000)).toBe(true);
    expect(statSync(path).size).toBeLessThan(6 * 1024 * 1024);
    expect(new DetachedChatDraftStore(path).snapshot()).toEqual(snapshot);
  });

  it("fails closed for malformed, oversized, and over-capacity snapshots", () => {
    const { path } = statePath();
    for (const content of [
      "{not-json",
      JSON.stringify({ version: 2, drafts: [] }),
      "x".repeat(6 * 1024 * 1024 + 1),
    ]) {
      writeFileSync(path, content);
      expect(new DetachedChatDraftStore(path).snapshot()).toEqual([]);
    }

    const validDraft = {
      conversationId: firstConversation,
      draft: "valid",
      handoffId: "22222222-2222-4222-8222-222222222222",
    };
    expect(parseDetachedChatDraftStore({
      version: 1,
      drafts: [validDraft, { ...validDraft, injected: true }],
    }).drafts).toEqual([validDraft]);
    expect(parseDetachedChatDraftStore({
      version: 1,
      drafts: Array.from(
        { length: MAX_PENDING_DETACHED_CHAT_DRAFTS + 1 },
        () => validDraft,
      ),
    }).drafts).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlink store without modifying its destination",
    () => {
      const { directory, path } = statePath();
      const destination = join(directory, "user-notes.txt");
      writeFileSync(destination, "keep this exact content", { mode: 0o600 });
      symlinkSync(destination, path);
      const store = new DetachedChatDraftStore(path);

      expect(store.snapshot()).toEqual([]);
      expect(() => store.put({
        conversationId: firstConversation,
        draft: "must not escape",
      })).toThrow("Unsafe secure state target");
      expect(store.snapshot()).toEqual([]);
      expect(readFileSync(destination, "utf8")).toBe("keep this exact content");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readdirSync(directory).sort()).toEqual([
        "detached-chat-pending-drafts.json",
        "user-notes.txt",
      ]);
    },
  );
});
