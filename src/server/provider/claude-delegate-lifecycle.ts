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
 * harness result. A non-deferred result is terminal even when the persistent
 * SDK input stream remains open for another prompt. Claude can also emit an
 * intermediate result to release SDK stdin while background agents report
 * back; only that explicitly deferred path waits for the parent to resume.
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
      const candidate = {
        message,
        deferred: isDeferredResult(message, this.liveBackgroundTaskIds.size > 0),
      };
      this.latestResult = candidate;
      return {
        turnEnded: !candidate.deferred
          && this.liveBackgroundTaskIds.size === 0,
      };
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
      return {
        turnEnded: this.liveBackgroundTaskIds.size === 0
          && this.latestResult !== undefined
          && !this.latestResult.deferred,
      };
    }

    if (
      message.subtype === "session_state_changed"
      && message.state === "idle"
      && this.latestResult
    ) {
      // Idle remains an authoritative fallback after the SDK flushes a held
      // result and exits its background-agent drain loop. Ordinary final
      // results settle earlier because persistent prompt input can keep the
      // iterator open without another idle edge.
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
