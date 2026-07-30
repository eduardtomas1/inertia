import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import type {
  AgentTurn,
  TurnGitArtifact,
  TurnGitArtifactAbsenceReason,
  TurnGitDiffSnapshot,
} from "../shared/contracts";
import {
  RuntimeStore,
  type StoredTurnGitArtifact,
} from "./database";
import { CheckpointError, createCheckpoint } from "./checkpoints";
import {
  captureGitArtifactState,
  compareGitSnapshots,
  GitError,
} from "./git";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_PATCHES = 200;
const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 60_000;
const DIGEST = /^[0-9a-f]{64}$/u;

export interface CaptureTurnGitArtifactInput {
  turn: AgentTurn;
  checkpointId: string | null;
  terminalAssistantMessageId?: string | null;
}

export interface TurnGitArtifactManagerOptions {
  finalizationTimeoutMs?: number;
}

export class TurnGitArtifactError extends Error {
  constructor(message: string) {
    super(message.slice(0, 240));
    this.name = "TurnGitArtifactError";
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof GitError) return error.message;
  if (error instanceof CheckpointError) {
    return error.message === "not-repository"
      ? "This workspace is not a Git repository."
      : "The repository snapshot could not be captured.";
  }
  return "The repository artifact could not be captured.";
}

function preCaptureAbsenceReason(
  error: unknown,
): TurnGitArtifactAbsenceReason | null {
  if (error instanceof GitError && error.code === "not-repository") {
    return "not-repository";
  }
  if (error instanceof CheckpointError && error.message === "not-repository") {
    return "not-repository";
  }
  return null;
}

function historicalTitle(artifact: TurnGitArtifact): string {
  const shortTurn = artifact.turnId.length > 12
    ? artifact.turnId.slice(0, 8)
    : artifact.turnId;
  return `Changed by turn ${shortTurn}`;
}

function truncatedCaptureReason(input: {
  summaryTruncated: boolean;
  patchTruncated: boolean;
}): string | null {
  if (input.summaryTruncated && input.patchTruncated) {
    return "The historical file summary and stored patch reached their capture limits.";
  }
  if (input.summaryTruncated) {
    return "The historical file list or change totals reached their capture limit.";
  }
  if (input.patchTruncated) {
    return "The complete file summary is retained, but the stored patch reached its size limit.";
  }
  return null;
}

export class TurnGitArtifactManager {
  readonly #patchDirectory: string;
  readonly #checkpointDirectory: string;
  readonly #finalizationTimeoutMs: number;
  readonly #finalizations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: RuntimeStore,
    dataDirectory: string,
    private readonly now: () => Date = () => new Date(),
    options: TurnGitArtifactManagerOptions = {},
  ) {
    this.#patchDirectory = resolve(dataDirectory, "turn-git-artifacts");
    this.#checkpointDirectory = resolve(dataDirectory, "checkpoint-indexes");
    this.#finalizationTimeoutMs = Math.max(
      1,
      options.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS,
    );
  }

  async captureBefore(input: CaptureTurnGitArtifactInput): Promise<void> {
    if (this.store.turnGitArtifact(input.turn.id)) return;
    const repositoryPath = this.store.conversationPath(input.turn.conversationId);
    let checkpointId = input.checkpointId;
    let beforeRef: string | null = null;
    try {
      if (checkpointId) {
        const checkpoint = this.store.checkpoint(checkpointId);
        if (
          checkpoint.conversationId !== input.turn.conversationId
          || (checkpoint.turnId !== null && checkpoint.turnId !== input.turn.id)
        ) throw new TurnGitArtifactError("The pre-turn checkpoint identity does not match this turn.");
        beforeRef = checkpoint.ref;
      } else {
        const privateCheckpoint = await createCheckpoint(
          repositoryPath,
          this.#checkpointDirectory,
          input.turn.conversationId,
        );
        beforeRef = privateCheckpoint.ref;
        checkpointId = null;
      }
      const state = await captureGitArtifactState(repositoryPath, beforeRef);
      this.store.createTurnGitArtifact({
        turnId: input.turn.id,
        repositoryIdentity: state.repositoryIdentity,
        worktreeIdentity: state.worktreeIdentity,
        branch: state.branch,
        beforeCheckpointId: checkpointId,
        beforeRef,
        beforeFingerprint: state.fingerprint,
        status: "pending",
        completeness: "partial",
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      if (!this.store.turnGitArtifact(input.turn.id)) {
        this.store.createTurnGitArtifact({
          turnId: input.turn.id,
          beforeCheckpointId: checkpointId,
          beforeRef,
          status: "unavailable",
          completeness: "unavailable",
          failureReason: safeFailure(error),
          absenceReason: preCaptureAbsenceReason(error),
          createdAt: this.now().toISOString(),
        });
      }
    }
  }

  async captureAfter(input: CaptureTurnGitArtifactInput): Promise<void> {
    let artifact = this.store.turnGitArtifact(input.turn.id);
    if (!artifact) {
      // A crash before the pre-capture hook cannot be reconstructed honestly.
      this.store.createTurnGitArtifact({
        turnId: input.turn.id,
        beforeCheckpointId: input.checkpointId,
        status: "unavailable",
        completeness: "unavailable",
        failureReason: "The pre-turn repository snapshot was not captured.",
        createdAt: this.now().toISOString(),
      });
      return;
    }
    if (artifact.status !== "pending") {
      if (
        artifact.capturedAt === null
        || artifact.terminalAssistantMessageId !== (input.terminalAssistantMessageId ?? null)
      ) {
        this.store.completeTurnGitArtifact(input.turn.id, {
          status: artifact.status,
          completeness: artifact.completeness,
          patchState: artifact.patchState,
          capturedAt: this.now().toISOString(),
          terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
          failureReason: artifact.failureReason,
          absenceReason: artifact.absenceReason ?? null,
        });
      }
      return;
    }
    const stored = this.store.turnGitArtifactStorage(input.turn.id);
    if (
      !stored.beforeRef
      || !stored.beforeFingerprint
      || !stored.repositoryIdentity
      || !stored.worktreeIdentity
    ) {
      this.#completeIfPending(input.turn.id, {
        status: "unavailable",
        completeness: "unavailable",
        patchState: "none",
        capturedAt: this.now().toISOString(),
        terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
        failureReason: stored.failureReason ?? "The pre-turn Git state was unavailable.",
      });
      return;
    }

    const repositoryPath = this.store.conversationPath(input.turn.conversationId);
    let afterRef: string | null = null;
    try {
      const postSnapshot = await createCheckpoint(
        repositoryPath,
        this.#checkpointDirectory,
        input.turn.conversationId,
      );
      afterRef = postSnapshot.ref;
      const after = await captureGitArtifactState(repositoryPath, afterRef);
      if (
        after.repositoryIdentity !== stored.repositoryIdentity
        || after.worktreeIdentity !== stored.worktreeIdentity
      ) {
        this.#completeIfPending(input.turn.id, {
          afterRef,
          afterFingerprint: after.fingerprint,
          status: "partial",
          completeness: "partial",
          patchState: "none",
          capturedAt: this.now().toISOString(),
          terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
          failureReason: "The repository or worktree changed identity during the turn.",
        });
        return;
      }
      const comparison = await compareGitSnapshots(
        repositoryPath,
        stored.beforeRef,
        afterRef,
        { maxBytes: MAX_PATCH_BYTES },
      );
      const digest = await this.#writePatch(comparison.patch);
      this.#completeIfPending(input.turn.id, {
        afterRef,
        afterFingerprint: after.fingerprint,
        files: comparison.files,
        insertions: comparison.insertions,
        deletions: comparison.deletions,
        status: comparison.truncated ? "partial" : "ready",
        completeness: comparison.truncated ? "truncated" : "complete",
        patchState: comparison.patchTruncated ? "truncated" : "available",
        patchDigest: digest,
        capturedAt: this.now().toISOString(),
        terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
        failureReason: truncatedCaptureReason(comparison),
      });
      await this.prune();
    } catch (error) {
      this.#completeIfPending(input.turn.id, {
        afterRef,
        status: stored.beforeRef ? "partial" : "failed",
        completeness: stored.beforeRef ? "partial" : "unavailable",
        patchState: "failed",
        capturedAt: this.now().toISOString(),
        terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
        failureReason: safeFailure(error),
      });
    }
  }

  /**
   * Completes a post-turn capture without allowing Git work to hold lifecycle
   * settlement indefinitely. Concurrent callers share one finalization and a
   * late capture cannot overwrite the bounded timeout state.
   */
  finalize(input: CaptureTurnGitArtifactInput): Promise<void> {
    const existing = this.#finalizations.get(input.turn.id);
    if (existing) return existing;
    const task = this.#finalizeBounded(input).finally(() => {
      if (this.#finalizations.get(input.turn.id) === task) {
        this.#finalizations.delete(input.turn.id);
      }
    });
    this.#finalizations.set(input.turn.id, task);
    return task;
  }

  async reconcile(): Promise<boolean> {
    const before = this.store.turnGitArtifactRevision();
    for (const artifact of this.store.pendingTurnGitArtifacts()) {
      const turn = this.store.agentTurn(artifact.turnId);
      if (
        turn.status !== "completed"
        && turn.status !== "failed"
        && turn.status !== "cancelled"
        && turn.status !== "interrupted"
      ) continue;
      await this.finalize({
        turn,
        checkpointId: turn.checkpointId,
        terminalAssistantMessageId: turn.terminalAssistantMessageId,
      });
    }

    for (const turn of this.store.terminalAuthoritativeAgentTurnsMissingGitArtifacts()) {
      this.store.createTurnGitArtifact({
        turnId: turn.id,
        beforeCheckpointId: turn.checkpointId,
        status: "unavailable",
        completeness: "unavailable",
        failureReason: "No authoritative pre-turn Git capture was persisted.",
        createdAt: turn.completedAt ?? turn.updatedAt,
      });
    }
    await this.prune();
    return this.store.turnGitArtifactRevision() !== before;
  }

  async #finalizeBounded(input: CaptureTurnGitArtifactInput): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => this.captureAfter(input));
    const outcome = await Promise.race([
      work.then(() => "captured" as const, () => "failed" as const),
      new Promise<"timed-out">((resolveTimeout) => {
        timeout = setTimeout(
          () => resolveTimeout("timed-out"),
          this.#finalizationTimeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === "captured") return;

    // The underlying Git commands have their own process timeouts. This state
    // transition bounds renderer/restart reconciliation and prevents any late
    // command result from replacing the authoritative timeout.
    this.#completeIfPending(input.turn.id, {
      status: "failed",
      completeness: "partial",
      patchState: "failed",
      capturedAt: this.now().toISOString(),
      terminalAssistantMessageId: input.terminalAssistantMessageId ?? null,
      failureReason: outcome === "timed-out"
        ? "Capturing turn changes timed out."
        : "The repository artifact could not be finalized.",
    });
    void work.catch(() => undefined);
  }

  #completeIfPending(
    turnId: string,
    input: Parameters<RuntimeStore["completeTurnGitArtifact"]>[1],
  ): StoredTurnGitArtifact | null {
    const current = this.store.turnGitArtifact(turnId);
    if (!current || current.status !== "pending") return null;
    return this.store.completeTurnGitArtifact(turnId, input);
  }

  async turnDiff(turnId: string, path?: string): Promise<TurnGitDiffSnapshot> {
    const artifact = this.store.turnGitArtifactStorage(turnId);
    if (path && !artifact.files.some((file) => file.path === path || file.previousPath === path)) {
      throw new TurnGitArtifactError("That file does not belong to this turn artifact.");
    }
    const patch = await this.#readPatch(artifact);
    return {
      artifactId: artifact.id,
      turnId: artifact.turnId,
      title: historicalTitle(artifact),
      completeness: artifact.completeness,
      patchState: artifact.patchState,
      patch,
      truncated: artifact.completeness !== "complete",
      files: artifact.files,
    };
  }

  async compare(
    earlierTurnId: string,
    laterTurnId: string,
    path?: string,
  ): Promise<TurnGitDiffSnapshot> {
    if (earlierTurnId === laterTurnId) {
      throw new TurnGitArtifactError("Choose two different turns to compare.");
    }
    const earlier = this.store.turnGitArtifactStorage(earlierTurnId);
    const later = this.store.turnGitArtifactStorage(laterTurnId);
    if (
      !earlier.afterRef
      || !later.afterRef
      || earlier.repositoryIdentity === null
      || earlier.repositoryIdentity !== later.repositoryIdentity
      || earlier.worktreeIdentity === null
      || earlier.worktreeIdentity !== later.worktreeIdentity
    ) {
      throw new TurnGitArtifactError("These turns do not have comparable repository snapshots.");
    }
    const comparison = await compareGitSnapshots(
      this.store.conversationPath(later.conversationId),
      earlier.afterRef,
      later.afterRef,
      { maxBytes: MAX_PATCH_BYTES, ...(path ? { paths: [path] } : {}) },
    );
    return {
      artifactId: `${earlier.id}:${later.id}`,
      turnId: later.turnId,
      title: `Compare ${historicalTitle(earlier).replace("Changed by ", "")} → ${historicalTitle(later).replace("Changed by ", "")}`,
      completeness: comparison.truncated ? "truncated" : "complete",
      patchState: comparison.patchTruncated ? "truncated" : "available",
      patch: comparison.patch,
      truncated: comparison.truncated,
      files: comparison.files,
    };
  }

  async prune(): Promise<void> {
    await mkdir(this.#patchDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#patchDirectory, { withFileTypes: true });
    const candidates = (await Promise.all(entries.flatMap((entry) => {
      const match = /^([0-9a-f]{64})\.gz$/u.exec(entry.name);
      if (!entry.isFile() || !match) return [];
      const path = join(this.#patchDirectory, entry.name);
      return [stat(path).then((info) => ({
        digest: match[1]!,
        path,
        size: info.size,
        modifiedAt: info.mtimeMs,
      })).catch(() => null)];
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.digest.localeCompare(right.digest));
    let retainedBytes = 0;
    let retainedCount = 0;
    for (const entry of candidates) {
      retainedBytes += entry.size;
      retainedCount += 1;
      if (retainedCount <= MAX_RETAINED_PATCHES && retainedBytes <= MAX_RETAINED_BYTES) continue;
      await rm(entry.path, { force: true });
      this.store.expireTurnGitPatch(entry.digest);
    }
  }

  async #writePatch(patch: string): Promise<string> {
    const content = Buffer.from(patch, "utf8");
    if (content.length > MAX_PATCH_BYTES) {
      throw new TurnGitArtifactError("The historical patch exceeded its storage limit.");
    }
    const digest = createHash("sha256").update(content).digest("hex");
    const compressed = gzipSync(content, { level: 9 });
    if (compressed.length > MAX_COMPRESSED_BYTES) {
      throw new TurnGitArtifactError("The compressed historical patch exceeded its storage limit.");
    }
    await mkdir(this.#patchDirectory, { recursive: true, mode: 0o700 });
    const target = this.#patchPath(digest);
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(compressed);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
    }
    return digest;
  }

  async #readPatch(artifact: StoredTurnGitArtifact): Promise<string> {
    if (
      !artifact.patchDigest
      || (artifact.patchState !== "available" && artifact.patchState !== "truncated")
    ) {
      throw new TurnGitArtifactError(
        artifact.patchState === "expired"
          ? "This historical patch has expired; its file summary remains available."
          : artifact.failureReason ?? "This historical patch is unavailable.",
      );
    }
    const compressed = await readFile(this.#patchPath(artifact.patchDigest)).catch(() => null);
    if (!compressed || compressed.length > MAX_COMPRESSED_BYTES) {
      this.store.expireTurnGitPatch(artifact.patchDigest);
      throw new TurnGitArtifactError("This historical patch is no longer available.");
    }
    let content: Buffer;
    try {
      content = gunzipSync(compressed, { maxOutputLength: MAX_PATCH_BYTES + 1 });
    } catch {
      throw new TurnGitArtifactError("This historical patch could not be read safely.");
    }
    if (
      content.length > MAX_PATCH_BYTES
      || createHash("sha256").update(content).digest("hex") !== artifact.patchDigest
    ) {
      throw new TurnGitArtifactError("This historical patch failed integrity validation.");
    }
    return content.toString("utf8");
  }

  #patchPath(digest: string): string {
    if (!DIGEST.test(digest)) throw new TurnGitArtifactError("The artifact digest is invalid.");
    return join(this.#patchDirectory, `${digest}.gz`);
  }
}
