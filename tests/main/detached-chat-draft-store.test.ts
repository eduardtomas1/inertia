import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  detachedChatDraftRecoveryPaths,
  MAX_QUARANTINED_DETACHED_CHAT_DRAFT_STATES,
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
    const diagnostics: unknown[] = [];
    const pending = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).put({
      conversationId: firstConversation,
      draft: "",
    });

    expect(new DetachedChatDraftStore(path).snapshot()).toEqual([pending]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      drafts: [pending],
    });
    expect(diagnostics).toEqual([]);
    expect(JSON.parse(readFileSync(
      detachedChatDraftRecoveryPaths(path).lastKnownGoodPath,
      "utf8",
    ))).toEqual({ version: 1, drafts: [pending] });
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
      expect(readdirSync(directory).sort()).toEqual([
        ".detached-chat-pending-drafts.json.last-known-good",
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

  it("quarantines malformed state, restores the bounded last-known-good copy, and preserves evidence across later writes", () => {
    const { path } = statePath();
    const first = new DetachedChatDraftStore(path).put({
      conversationId: firstConversation,
      draft: "recover this exact draft",
    });
    const damaged = "{not-json-with-private-draft-evidence";
    writeFileSync(path, damaged, { mode: 0o600 });
    const diagnostics: unknown[] = [];

    const recovered = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(recovered.snapshot()).toEqual([first]);
    expect(diagnostics).toEqual([
      {
        reason: "invalid-json",
        outcome: "quarantined",
        evidencePreserved: true,
      },
      {
        reason: "invalid-json",
        outcome: "recovered",
        evidencePreserved: true,
      },
    ]);
    const recoveryDirectory = detachedChatDraftRecoveryPaths(path).directory;
    const evidence = readdirSync(recoveryDirectory);
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(recoveryDirectory, evidence[0]!), "utf8"))
      .toBe(damaged);

    const replacement = recovered.put({
      conversationId: firstConversation,
      draft: "newer recovered draft",
    });
    expect(new DetachedChatDraftStore(path).snapshot()).toEqual([replacement]);
    expect(readdirSync(recoveryDirectory)).toEqual(evidence);
    expect(readFileSync(join(recoveryDirectory, evidence[0]!), "utf8"))
      .toBe(damaged);
  });

  it("recovers a missing primary from the last-known-good copy on restart", () => {
    const { path } = statePath();
    const pending = new DetachedChatDraftStore(path).put({
      conversationId: firstConversation,
      draft: "survive restart",
    });
    rmSync(path);
    const diagnostics: unknown[] = [];

    const restarted = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(restarted.snapshot()).toEqual([pending]);
    expect(diagnostics).toEqual([{
      reason: "missing",
      outcome: "recovered",
      evidencePreserved: true,
    }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      drafts: [pending],
    });
  });

  it("blocks later writes instead of erasing a divergent valid recovery copy", () => {
    const { path } = statePath();
    const diagnostics: unknown[] = [];
    const store = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const pending = store.put({
      conversationId: firstConversation,
      draft: "authoritative primary",
    });
    const recoveryPath = detachedChatDraftRecoveryPaths(path).lastKnownGoodPath;
    const recoverable = JSON.stringify({
      version: 1,
      drafts: [{ ...pending, draft: "divergent recovery evidence" }],
    });
    writeFileSync(recoveryPath, recoverable, { mode: 0o600 });

    expect(() => store.put({
      conversationId: firstConversation,
      draft: "must not erase evidence",
    })).toThrow("persistence is unavailable");
    expect(diagnostics).toEqual([{
      reason: "changed",
      outcome: "blocked",
      evidencePreserved: true,
    }]);
    expect(readFileSync(recoveryPath, "utf8")).toBe(recoverable);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      drafts: [pending],
    });

    const restartDiagnostics: unknown[] = [];
    expect(new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => restartDiagnostics.push(diagnostic),
    }).snapshot()).toEqual([pending]);
    expect(restartDiagnostics).toEqual([{
      reason: "changed",
      outcome: "quarantined",
      evidencePreserved: true,
    }]);
    const recoveryDirectory = detachedChatDraftRecoveryPaths(path).directory;
    const evidence = readdirSync(recoveryDirectory);
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(recoveryDirectory, evidence[0]!), "utf8"))
      .toBe(recoverable);
  });

  it.runIf(process.platform !== "win32")(
    "resolves a symlinked parent once and contains primary, backup, and recovery state in the real directory",
    () => {
    const { directory } = statePath();
    const realDirectory = join(directory, "real");
    const linkedDirectory = join(directory, "linked");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, "dir");
    const path = join(linkedDirectory, "detached-chat-pending-drafts.json");

    new DetachedChatDraftStore(path).put({
      conversationId: firstConversation,
      draft: "contained",
    });

    const paths = detachedChatDraftRecoveryPaths(path);
    const resolvedRealDirectory = realpathSync(realDirectory);
    expect(paths.target).toBe(join(
      resolvedRealDirectory,
      "detached-chat-pending-drafts.json",
    ));
    expect(paths.lastKnownGoodPath.startsWith(`${resolvedRealDirectory}/`))
      .toBe(true);
    expect(paths.directory.startsWith(`${resolvedRealDirectory}/`)).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "separates permission failures and blocks writes without replacing evidence",
    () => {
      const { path } = statePath();
      const pending = new DetachedChatDraftStore(path).put({
        conversationId: firstConversation,
        draft: "permission evidence",
      });
      const before = readFileSync(path, "utf8");
      chmodSync(path, 0o000);
      const diagnostics: unknown[] = [];
      try {
        const unavailable = new DetachedChatDraftStore(path, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
        expect(unavailable.snapshot()).toEqual([]);
        expect(() => unavailable.put({
          conversationId: firstConversation,
          draft: "must not replace",
        })).toThrow("persistence is unavailable");
        expect(diagnostics).toEqual([{
          reason: "permission",
          outcome: "blocked",
          evidencePreserved: true,
        }]);
      } finally {
        chmodSync(path, 0o600);
      }
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(JSON.parse(before).drafts).toEqual([pending]);
    },
  );

  it("separates transient filesystem failures and never treats them as ENOENT", () => {
    const { directory } = statePath();
    const path = join(directory, "x".repeat(300));
    const diagnostics: unknown[] = [];
    const unavailable = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(() => unavailable.put({
      conversationId: firstConversation,
      draft: "must remain in memory only",
    })).toThrow("persistence is unavailable");
    expect(diagnostics).toEqual([{
      reason: "transient-io",
      outcome: "blocked",
      evidencePreserved: true,
    }]);
  });

  it("bounds quarantined evidence and blocks instead of erasing the next damaged state", () => {
    const { path } = statePath();
    for (
      let index = 0;
      index < MAX_QUARANTINED_DETACHED_CHAT_DRAFT_STATES;
      index += 1
    ) {
      writeFileSync(path, `{damaged-${index}`, { mode: 0o600 });
      new DetachedChatDraftStore(path);
    }
    const finalEvidence = "{damaged-after-bound";
    writeFileSync(path, finalEvidence, { mode: 0o600 });
    const diagnostics: unknown[] = [];

    const blocked = new DetachedChatDraftStore(path, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(readdirSync(detachedChatDraftRecoveryPaths(path).directory))
      .toHaveLength(MAX_QUARANTINED_DETACHED_CHAT_DRAFT_STATES);
    expect(readFileSync(path, "utf8")).toBe(finalEvidence);
    expect(() => blocked.put({
      conversationId: firstConversation,
      draft: "must not erase bounded evidence",
    })).toThrow("persistence is unavailable");
    expect(diagnostics).toEqual([{
      reason: "transient-io",
      outcome: "blocked",
      evidencePreserved: true,
    }]);
    expect(readFileSync(path, "utf8")).toBe(finalEvidence);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlink store without modifying its destination",
    () => {
      const { directory, path } = statePath();
      const destination = join(directory, "user-notes.txt");
      writeFileSync(destination, "keep this exact content", { mode: 0o600 });
      symlinkSync(destination, path);
      const diagnostics: unknown[] = [];
      const store = new DetachedChatDraftStore(path, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(store.snapshot()).toEqual([]);
      expect(() => store.put({
        conversationId: firstConversation,
        draft: "must not escape",
      })).toThrow("persistence is unavailable");
      expect(store.snapshot()).toEqual([]);
      expect(readFileSync(destination, "utf8")).toBe("keep this exact content");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(diagnostics).toEqual([{
        reason: "unsafe",
        outcome: "blocked",
        evidencePreserved: true,
      }]);
      expect(readdirSync(directory).sort()).toEqual([
        "detached-chat-pending-drafts.json",
        "user-notes.txt",
      ]);
    },
  );
});
