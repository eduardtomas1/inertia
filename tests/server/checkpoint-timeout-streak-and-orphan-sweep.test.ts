import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface RecordedGitCall {
  cwd: string;
  args: string[];
  timeoutMs: number | undefined;
  deadlineAt: number | undefined;
}

const gitControls = vi.hoisted(() => ({
  calls: [] as RecordedGitCall[],
  failWithTimeout: false,
  onRunGit: null as null | ((cwd: string, args: readonly string[], options: { timeoutMs?: number; deadlineAt?: number }) => Promise<void> | void),
}));

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/git/runner")>();
  const { GitError } = await import("../../src/server/git/types");
  return {
    ...original,
    runGit: async (...parameters: Parameters<typeof original.runGit>) => {
      const [cwd, args, options] = parameters;
      gitControls.calls.push({
        cwd,
        args: [...args],
        timeoutMs: options.timeoutMs,
        deadlineAt: options.deadlineAt,
      });
      if (gitControls.onRunGit) {
        await gitControls.onRunGit(cwd, args, options);
      }
      if (gitControls.failWithTimeout) {
        throw new GitError("timeout", "Git took too long to complete the operation.");
      }
      return await original.runGit(...parameters);
    },
  };
});

import {
  CHECKPOINT_DEFAULT_TIMEOUT_MS,
  CHECKPOINT_SHORTENED_PRE_TURN_TIMEOUT_MS,
  CHECKPOINT_TIMEOUT_COOLDOWN_MS,
  CheckpointError,
  CheckpointUnavailableError,
  MAX_CHECKPOINT_WORKSPACE_STATE_ENTRIES,
  createCheckpoint,
  getWorkspaceCheckpointTimeoutState,
  pruneOrphanedCheckpointRefs,
  resetCheckpointWorkspaceState,
} from "../../src/server/checkpoints";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

describe("checkpoint timeout streak, shared-folder contention, and orphaned ref sweep", () => {
  const roots: string[] = [];

  afterEach(() => {
    gitControls.calls.splice(0);
    gitControls.failWithTimeout = false;
    gitControls.onRunGit = null;
    resetCheckpointWorkspaceState();
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function createRepo(): { root: string; indexes: string } {
    const root = mkdtempSync(join(tmpdir(), "inertia-checkpoint-d5-"));
    const indexes = mkdtempSync(join(tmpdir(), "inertia-checkpoint-d5-idx-"));
    roots.push(root, indexes);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "base");
    return { root, indexes };
  }

  it("shortens pre-turn timeout budget after 2 consecutive timeouts and resets on pre-turn or post-turn success", async () => {
    const { root, indexes } = createRepo();
    const conversationId = randomUUID();
    let now = 1_000_000;
    const clock = () => now;

    gitControls.failWithTimeout = true;

    // Timeout #1: full 20s timeout budget, streak becomes 1.
    await expect(
      createCheckpoint(root, indexes, conversationId, { phase: "pre-turn", now: clock }),
    ).rejects.toThrow("Checkpoint operation timed out.");
    expect(gitControls.calls.at(-1)?.timeoutMs).toBe(CHECKPOINT_DEFAULT_TIMEOUT_MS);
    expect(await getWorkspaceCheckpointTimeoutState(root)).toEqual({
      streak: 1,
      cooldownUntil: now + CHECKPOINT_TIMEOUT_COOLDOWN_MS,
    });

    // Timeout #2: still full 20s budget (streak was 1 < 2), streak becomes 2.
    now += 1_000;
    await expect(
      createCheckpoint(root, indexes, conversationId, { phase: "pre-turn", now: clock }),
    ).rejects.toThrow("Checkpoint operation timed out.");
    expect(gitControls.calls.at(-1)?.timeoutMs).toBe(CHECKPOINT_DEFAULT_TIMEOUT_MS);
    expect(await getWorkspaceCheckpointTimeoutState(root)).toEqual({
      streak: 2,
      cooldownUntil: now + CHECKPOINT_TIMEOUT_COOLDOWN_MS,
    });

    // Attempt #3 within cooldown: pre-turn budget is shortened to 3s (and caps caller's 20s deadlineAt).
    now += 1_000;
    const callerDeadline = now + CHECKPOINT_DEFAULT_TIMEOUT_MS;
    await expect(
      createCheckpoint(root, indexes, conversationId, { phase: "pre-turn", now: clock, deadlineAt: callerDeadline }),
    ).rejects.toThrow("Checkpoint operation timed out.");
    expect(gitControls.calls.at(-1)?.timeoutMs).toBe(CHECKPOINT_SHORTENED_PRE_TURN_TIMEOUT_MS);
    expect(gitControls.calls.at(-1)?.deadlineAt).toBe(now + CHECKPOINT_SHORTENED_PRE_TURN_TIMEOUT_MS);
    expect((await getWorkspaceCheckpointTimeoutState(root)).streak).toBe(3);

    // Post-turn success resets the streak back to 0.
    gitControls.failWithTimeout = false;
    const postCaptured = await createCheckpoint(root, indexes, conversationId, { phase: "post-turn", now: clock });
    expect(refExists(root, postCaptured.ref)).toBe(true);
    expect(await getWorkspaceCheckpointTimeoutState(root)).toEqual({ streak: 0, cooldownUntil: 0 });

    // Subsequent pre-turn probe gets the full 20s timeout budget again.
    gitControls.calls.splice(0);
    const preCaptured = await createCheckpoint(root, indexes, conversationId, { phase: "pre-turn", now: clock });
    expect(refExists(root, preCaptured.ref)).toBe(true);
    expect(gitControls.calls[0]?.timeoutMs).toBe(CHECKPOINT_DEFAULT_TIMEOUT_MS);
  });

  it("restores the full pre-turn timeout budget once the cooldown expires and bounds workspace state to 256 entries", async () => {
    const { root, indexes } = createRepo();
    const conversationId = randomUUID();
    let now = 2_000_000;
    const clock = () => now;

    gitControls.failWithTimeout = true;
    await expect(createCheckpoint(root, indexes, conversationId, { now: clock })).rejects.toBeInstanceOf(CheckpointError);
    await expect(createCheckpoint(root, indexes, conversationId, { now: clock })).rejects.toBeInstanceOf(CheckpointError);
    expect((await getWorkspaceCheckpointTimeoutState(root)).streak).toBe(2);

    // Advancing past cooldown restores full timeout budget even before a success.
    now += CHECKPOINT_TIMEOUT_COOLDOWN_MS + 1;
    gitControls.calls.splice(0);
    await expect(createCheckpoint(root, indexes, conversationId, { now: clock })).rejects.toBeInstanceOf(CheckpointError);
    expect(gitControls.calls[0]?.timeoutMs).toBe(CHECKPOINT_DEFAULT_TIMEOUT_MS);

    // Evicts oldest workspace entries once > 256 distinct workspaces record timeouts.
    const oldestWorkspace = join(root, "ws-0");
    for (let i = 0; i < MAX_CHECKPOINT_WORKSPACE_STATE_ENTRIES + 5; i += 1) {
      await expect(
        createCheckpoint(join(root, `ws-${i}`), indexes, conversationId, { now: clock }),
      ).rejects.toBeInstanceOf(CheckpointError);
    }
    expect(await getWorkspaceCheckpointTimeoutState(oldestWorkspace)).toEqual({ streak: 0, cooldownUntil: 0 });
    expect((await getWorkspaceCheckpointTimeoutState(join(root, `ws-${MAX_CHECKPOINT_WORKSPACE_STATE_ENTRIES + 4}`))).streak)
      .toBe(1);
  });

  it("serializes shared-folder captures and immediately skips duplicate pre-turn waiters after an active timeout", async () => {
    const { root, indexes } = createRepo();
    const convA = randomUUID();
    const convB = randomUUID();
    const convC = randomUUID();

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });

    let blockedOnce = false;
    gitControls.onRunGit = async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        firstEntered();
        await firstGate;
      }
    };

    const captureA = createCheckpoint(root, indexes, convA, { phase: "pre-turn" });
    await enteredPromise;

    const callsWhileActive = gitControls.calls.length;
    // Waiters on the same normalized workspace folder (including trailing slash variant) queue behind A.
    const captureB = createCheckpoint(root, indexes, convB, { phase: "pre-turn" });
    const captureC = createCheckpoint(`${root}/`, indexes, convC, { phase: "pre-turn" });
    await Promise.resolve();
    expect(gitControls.calls.length).toBe(callsWhileActive);

    // First capture times out -> waiters B and C must skip immediately as unavailable with zero extra git calls.
    gitControls.failWithTimeout = true;
    releaseFirst();

    await expect(captureA).rejects.toThrow("Checkpoint operation timed out.");
    await expect(captureB).rejects.toBeInstanceOf(CheckpointUnavailableError);
    await expect(captureC).rejects.toBeInstanceOf(CheckpointUnavailableError);
    expect(gitControls.calls.length).toBe(callsWhileActive);

    // A later capture after the timed-out wave completes proceeds normally and succeeds.
    gitControls.failWithTimeout = false;
    gitControls.onRunGit = null;
    const captureD = await createCheckpoint(root, indexes, convA, { phase: "pre-turn" });
    expect(refExists(root, captureD.ref)).toBe(true);
  });

  it("runs concurrent captures sequentially when the first succeeds and does not skip post-turn waiters after a pre-turn timeout", async () => {
    const { root, indexes } = createRepo();
    const convA = randomUUID();
    const convB = randomUUID();

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });

    let blockedOnce = false;
    gitControls.onRunGit = async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        firstEntered();
        await firstGate;
      }
    };

    const preA = createCheckpoint(root, indexes, convA, { phase: "pre-turn" });
    await enteredPromise;
    const postB = createCheckpoint(root, indexes, convB, { phase: "post-turn" });

    gitControls.failWithTimeout = true;
    releaseFirst();
    await expect(preA).rejects.toThrow("Checkpoint operation timed out.");

    // Allow post-turn capture B to succeed after A timed out -> B runs and resets the timeout streak.
    gitControls.failWithTimeout = false;
    gitControls.onRunGit = null;
    const capturedB = await postB;
    expect(refExists(root, capturedB.ref)).toBe(true);
    expect(await getWorkspaceCheckpointTimeoutState(root)).toEqual({ streak: 0, cooldownUntil: 0 });
  });

  it("pruneOrphanedCheckpointRefs deletes only orphaned refs/inertia/checkpoints/<uuid>/* refs and preserves live and non-checkpoint refs", async () => {
    const { root, indexes } = createRepo();
    const liveConvId = randomUUID();
    const orphanConvId1 = randomUUID();
    const orphanConvId2 = randomUUID();
    const headSha = git(root, "rev-parse", "HEAD");

    const live1 = await createCheckpoint(root, indexes, liveConvId);
    const live2 = await createCheckpoint(root, indexes, liveConvId);
    const orphan1 = await createCheckpoint(root, indexes, orphanConvId1);
    const orphan2 = await createCheckpoint(root, indexes, orphanConvId1);
    const orphan3 = await createCheckpoint(root, indexes, orphanConvId2);
    const orphan4 = await createCheckpoint(root, indexes, orphanConvId2);

    // Create non-checkpoint refs and a malformed ref under the checkpoint prefix.
    git(root, "branch", "feature-keep");
    git(root, "tag", "v1.0.0");
    git(root, "update-ref", `refs/inertia/other/${orphanConvId1}/keep`, headSha);
    git(root, "update-ref", "refs/inertia/checkpoints/not-a-uuid/keep", headSha);

    const firstSweep = await pruneOrphanedCheckpointRefs(
      root,
      new Set([liveConvId]),
      { maxDelete: 3 },
    );
    expect(firstSweep).toEqual({ scanned: 6, deleted: 3 });

    // Live refs and non-checkpoint refs remain untouched.
    expect(refExists(root, live1.ref)).toBe(true);
    expect(refExists(root, live2.ref)).toBe(true);
    expect(refExists(root, "refs/heads/main")).toBe(true);
    expect(refExists(root, "refs/heads/feature-keep")).toBe(true);
    expect(refExists(root, "refs/tags/v1.0.0")).toBe(true);
    expect(refExists(root, `refs/inertia/other/${orphanConvId1}/keep`)).toBe(true);
    expect(refExists(root, "refs/inertia/checkpoints/not-a-uuid/keep")).toBe(true);

    const remainingOrphansAfterFirst = [orphan1.ref, orphan2.ref, orphan3.ref, orphan4.ref]
      .filter((ref) => refExists(root, ref));
    expect(remainingOrphansAfterFirst).toHaveLength(1);

    // Second sweep deletes the last remaining orphaned checkpoint ref.
    const secondSweep = await pruneOrphanedCheckpointRefs(root, new Set([liveConvId]));
    expect(secondSweep).toEqual({ scanned: 3, deleted: 1 });
    for (const ref of [orphan1.ref, orphan2.ref, orphan3.ref, orphan4.ref]) {
      expect(refExists(root, ref)).toBe(false);
    }
    expect(refExists(root, live1.ref)).toBe(true);
    expect(refExists(root, live2.ref)).toBe(true);
    expect(refExists(root, "refs/inertia/checkpoints/not-a-uuid/keep")).toBe(true);

    // Respects allowedRoot containment boundary.
    const outsideRoot = mkdtempSync(join(tmpdir(), "inertia-outside-root-"));
    roots.push(outsideRoot);
    await expect(
      pruneOrphanedCheckpointRefs(root, new Set([liveConvId]), { allowedRoot: outsideRoot }),
    ).rejects.toBeInstanceOf(CheckpointError);
  });

  it("pruneOrphanedCheckpointRefs deletes a symbolic checkpoint ref without dereferencing or deleting its target branch (S30)", async () => {
    const { root } = createRepo();
    const liveConvId = randomUUID();
    const orphanConvId = randomUUID();
    const mainSha = git(root, "rev-parse", "refs/heads/main");
    const symRef = `refs/inertia/checkpoints/${orphanConvId}/sym-test`;

    git(root, "symbolic-ref", symRef, "refs/heads/main");
    expect(git(root, "symbolic-ref", symRef)).toBe("refs/heads/main");

    const sweep = await pruneOrphanedCheckpointRefs(root, new Set([liveConvId]));
    expect(sweep).toEqual({ scanned: 1, deleted: 1 });
    expect(refExists(root, symRef)).toBe(false);
    expect(git(root, "for-each-ref", "--format=%(refname)", symRef)).toBe("");
    expect(refExists(root, "refs/heads/main")).toBe(true);
    expect(git(root, "rev-parse", "refs/heads/main")).toBe(mainSha);
  });

  it("keeps later waiters serialized behind an active capture when a queued waiter aborts (S31)", async () => {
    const { root, indexes } = createRepo();
    const convA = randomUUID();
    const convB = randomUUID();
    const convC = randomUUID();

    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { firstEntered = resolve; });

    let blockedOnce = false;
    gitControls.onRunGit = async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        firstEntered();
        await firstGate;
      }
    };

    const captureA = createCheckpoint(root, indexes, convA, { phase: "pre-turn" });
    await enteredPromise;
    const callsWhileABlocked = gitControls.calls.length;

    const abortB = new AbortController();
    const captureB = createCheckpoint(root, indexes, convB, {
      phase: "pre-turn",
      signal: abortB.signal,
    });
    // Ensure B has resolved its workspace key and queued behind A before C queues behind B.
    await new Promise<void>((resolve) => setTimeout(resolve, 15));

    const captureC = createCheckpoint(root, indexes, convC, { phase: "pre-turn" });
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(gitControls.calls.length).toBe(callsWhileABlocked);

    // Abort B while A is still active: B fails promptly, but C must NOT start while A still holds the workspace lock.
    abortB.abort();
    await expect(captureB).rejects.toThrow("Checkpoint operation timed out.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(gitControls.calls.length).toBe(callsWhileABlocked);

    // Once A finishes, C proceeds sequentially and succeeds.
    releaseFirst();
    const [resultA, resultC] = await Promise.all([captureA, captureC]);
    expect(refExists(root, resultA.ref)).toBe(true);
    expect(refExists(root, resultC.ref)).toBe(true);
  });
});
