import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type ClaudeDelegateCompletion =
  | { kind: "result"; result: SDKResultMessage }
  | {
      kind: "incomplete";
      reason: "missing-result" | "delegates-abandoned" | "parent-not-resumed";
    };

/**
 * Provider-private gate between Claude's per-turn results and the neutral
 * harness result. Claude can emit an intermediate result to release SDK stdin,
 * then keep the CLI process alive while background agents report back.
 */
export class ClaudeDelegateLifecycle {
  private liveBackgroundTaskIds = new Set<string>();
  private latestResult:
    | {
        message: SDKResultMessage;
        deferred: boolean;
      }
    | undefined;
  private endedAtAuthoritativeIdle = false;

  observe(message: SDKMessage): { turnEnded: boolean } {
    if (message.type === "result") {
      this.latestResult = {
        message,
        deferred: isDeferredResult(message, this.liveBackgroundTaskIds.size > 0),
      };
      return { turnEnded: false };
    }

    if (message.type !== "system") {
      return { turnEnded: false };
    }

    if (message.subtype === "init") {
      // The background-task level is process-local. A restarted CLI begins
      // with an empty level until it publishes the next membership change.
      this.liveBackgroundTaskIds.clear();
      return { turnEnded: false };
    }

    if (message.subtype === "background_tasks_changed") {
      // This is a level signal with REPLACE semantics. Do not pair it with
      // task_started/task_notification edges; their relative order is not
      // guaranteed by the SDK.
      this.liveBackgroundTaskIds = new Set(
        message.tasks
          .map((task) => task.task_id)
          .filter((taskId) => taskId.length > 0),
      );
      return { turnEnded: false };
    }

    if (
      message.subtype === "session_state_changed"
      && message.state === "idle"
      && this.latestResult
    ) {
      // The SDK defines idle as occurring after heldBackResult is flushed and
      // the background-agent drain loop exits. It supersedes stale edge/level
      // ordering and is the earliest safe point to close this one-turn query.
      this.endedAtAuthoritativeIdle = true;
      this.liveBackgroundTaskIds.clear();
      return { turnEnded: true };
    }

    return { turnEnded: false };
  }

  complete(): ClaudeDelegateCompletion {
    const candidate = this.latestResult;
    if (!candidate) {
      return { kind: "incomplete", reason: "missing-result" };
    }
    if (candidate.deferred) {
      return { kind: "incomplete", reason: "parent-not-resumed" };
    }
    if (!this.endedAtAuthoritativeIdle && this.liveBackgroundTaskIds.size > 0) {
      return { kind: "incomplete", reason: "delegates-abandoned" };
    }
    return { kind: "result", result: candidate.message };
  }

  dispose(): void {
    this.liveBackgroundTaskIds.clear();
    this.latestResult = undefined;
    this.endedAtAuthoritativeIdle = false;
  }
}

function isDeferredResult(
  result: SDKResultMessage,
  hadLiveBackgroundTasks: boolean,
): boolean {
  if (result.terminal_reason === "background_requested") {
    return true;
  }
  // terminal_reason was added after background task support. On older
  // emitters, a result observed while the authoritative level is non-empty is
  // conservatively treated as the parent's pre-notification result.
  return result.terminal_reason === undefined && hadLiveBackgroundTasks;
}
