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
 * back. Explicit deferral and exact live delegated-work evidence both require
 * a newer parent result after the provider reports that work settled.
 */
export class ClaudeDelegateLifecycle {
  private liveBackgroundTaskIds = new Set<string>();
  private observedBackgroundTaskLevel = false;
  private latestResult:
    | {
        message: SDKResultMessage;
        deferred: boolean;
      }
    | undefined;
  private endedAtAuthoritativeIdle = false;

  observe(
    message: SDKMessage,
    hasLiveTaskTrace = false,
  ): { turnEnded: boolean } {
    if (message.type === "result") {
      const candidate = {
        message,
        deferred: isDeferredResult(
          message,
          this.liveBackgroundTaskIds.size > 0
            || (!this.observedBackgroundTaskLevel && hasLiveTaskTrace),
        ),
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
      this.observedBackgroundTaskLevel = false;
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
      this.observedBackgroundTaskLevel = true;
      return { turnEnded: this.canEndTurn() };
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

    return { turnEnded: this.canEndTurn() };
  }

  complete(): ClaudeDelegateCompletion {
    const candidate = this.latestResult;
    if (!candidate) {
      return { kind: "incomplete", reason: "missing-result" };
    }
    if (!this.endedAtAuthoritativeIdle && this.liveBackgroundTaskIds.size > 0) {
      return { kind: "incomplete", reason: "delegates-abandoned" };
    }
    if (candidate.deferred) {
      return { kind: "incomplete", reason: "parent-not-resumed" };
    }
    return { kind: "result", result: candidate.message };
  }

  dispose(): void {
    this.liveBackgroundTaskIds.clear();
    this.observedBackgroundTaskLevel = false;
    this.latestResult = undefined;
    this.endedAtAuthoritativeIdle = false;
  }

  hasProvisionalResult(): boolean {
    return this.latestResult?.deferred === true;
  }

  shouldBoundParentResumeWait(
    message: SDKMessage,
    hadLiveTaskTrace: boolean,
    hasLiveTaskTrace: boolean,
  ): boolean {
    return this.hasProvisionalResult() && (
      (message.type === "system"
        && message.subtype === "background_tasks_changed"
        && message.tasks.length === 0)
      || (!this.observedBackgroundTaskLevel
        && hadLiveTaskTrace
        && !hasLiveTaskTrace)
    );
  }

  private canEndTurn(): boolean {
    return this.liveBackgroundTaskIds.size === 0
      && this.latestResult !== undefined
      && !this.latestResult.deferred;
  }
}

function isDeferredResult(
  result: SDKResultMessage,
  hadLiveDelegatedWork: boolean,
): boolean {
  if (result.terminal_reason === "background_requested") {
    return true;
  }
  // A result is only authoritative for the state observed when it was
  // emitted. Claude can report `completed` before a background delegate's
  // completion auto-resumes the parent, so roster/trace liveness makes that
  // result provisional regardless of terminal_reason. A later parent result
  // replaces it after the exact delegated-work terminal edge.
  return hadLiveDelegatedWork;
}
