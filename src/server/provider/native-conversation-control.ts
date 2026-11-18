import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { createClaudeSkillDeadline, raceClaudeSkillOperation } from "./claude-skill-operation";
import {
  NativeConversationRejection, validateNativeConversationRequest,
  type NativeConversationLaunch, type NativeConversationRequest, type NativeConversationResult,
} from "./native-conversation-operations";

export interface NativeMutationProgress {
  mutationMayHaveOccurred: boolean;
  createdNativeConversationId?: string;
}

type Completed = Extract<NativeConversationResult, { status: "completed" }>;

/** Kept until actual settlement, including filesystem calls abandoned by a deadline. */
const pending = new Set<string>();

export async function controlNativeConversation(
  request: NativeConversationRequest,
  launch: NativeConversationLaunch,
  active: ReadonlySet<string>,
  joinCleanup: boolean,
  run: (signal: AbortSignal, progress: NativeMutationProgress) => Promise<Omit<Completed, "identity" | "operationId">>,
): Promise<NativeConversationResult> {
  const base = {
    operationId: request.operationId, identity: request.source.identity,
    ...(request.kind === "fork" ? { targetConversationId: request.targetConversationId } : {}),
  };
  const key = `${request.source.identity.providerInstanceId}\0${request.source.nativeConversationId}`;
  const progress: NativeMutationProgress = { mutationMayHaveOccurred: false };
  const deadline = createClaudeSkillDeadline(
    Number.isFinite(launch.timeoutMs) ? Math.max(1, launch.timeoutMs!) : 15_000,
    "Native conversation operation timed out.", launch.signal,
  );
  try {
    validateNativeConversationRequest(request, launch);
    deadline.signal.throwIfAborted();
    if (active.has(request.source.nativeConversationId) || pending.has(key)) {
      throw new NativeConversationRejection("rejected", "conversation-busy");
    }
    pending.add(key);
    const work = (async () => {
      try {
        const canonical = await realpath(launch.cwd);
        deadline.signal.throwIfAborted();
        if (canonical !== resolve(launch.cwd)) {
          throw new NativeConversationRejection("rejected", "workspace-not-canonical");
        }
        return await run(deadline.signal, progress);
      } finally {
        pending.delete(key);
      }
    })();
    // Codex must join its process-tree cleanup, even after the deadline. Claude
    // has no child here; bounded filesystem work retains the lock until settled.
    const result = joinCleanup ? await work : await raceClaudeSkillOperation(work, deadline.signal);
    return { ...base, ...result };
  } catch (error) {
    if (error instanceof NativeConversationRejection && !progress.mutationMayHaveOccurred) {
      return { ...base, status: error.status, reason: error.reason };
    }
    return {
      ...base, status: "failed",
      reason: isProcessTreeTerminationUnconfirmed(error) ? "cleanup-unconfirmed"
        : launch.signal?.aborted ? "cancelled"
          : deadline.signal.aborted ? "deadline" : "provider-failure",
      ...progress,
    };
  } finally {
    deadline.dispose();
    // Transfers accepted by Codex are settled by its owned control process.
    launch.installationUse?.abandonBeforeSpawn();
  }
}
