import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { claudeResultUserMessageIds } from "./claude-follow-up-correlation";
import { claudeCommandLifecycleMessage, claudeObjectValue } from "./claude-message-projector-support";

export type ClaudeDelegateCompletion =
  | { kind: "result"; result: SDKResultMessage }
  | {
      kind: "incomplete";
      reason: "missing-result" | "delegates-abandoned" | "parent-not-resumed"
        | "prompt-refused" | "prompt-cancelled" | "prompt-discarded" | "prompt-unanswered";
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
  private parentResumedAfterProvisional = false;
  private promptUuid: string | null = null;
  private promptPending = false;
  private promptCompletedUnanswered = false;
  private promptFailure: "prompt-refused" | "prompt-cancelled" | "prompt-discarded" | undefined;

  expectPrompt(uuid: string): void {
    this.promptUuid = uuid;
  }

  observe(
    message: SDKMessage,
    hasLiveTaskTrace = false,
  ): { turnEnded: boolean } {
    const command = claudeCommandLifecycleMessage(message);
    if (command) {
      if (command.command_uuid !== this.promptUuid) return { turnEnded: false };
      this.promptPending = command.state === "queued" || command.state === "started";
      if (command.state === "completed") this.promptCompletedUnanswered = !this.latestResult;
      if (command.state === "refused" || command.state === "cancelled" || command.state === "discarded") {
        this.promptFailure = `prompt-${command.state}`;
        return { turnEnded: true };
      }
      return { turnEnded: false };
    }

    if (
      message.type === "assistant"
      && this.latestResult?.deferred
      && (message as { parent_tool_use_id?: unknown }).parent_tool_use_id == null
    ) {
      // Root output after a provisional result proves the parent resumed. An
      // exit before its next result is a mid-turn exit, not a missed resume.
      this.parentResumedAfterProvisional = true;
    }

    if (message.type === "result") {
      const answersPrompt = claudeResultUserMessageIds(message).includes(this.promptUuid ?? "");
      const answersNotification = isClaudeNotificationResult(message);
      if (
        (isClaudeQueuedCompletionAck(message)
          && (this.latestResult || answersNotification || (this.promptPending && !answersPrompt)))
        || (!this.latestResult && answersNotification && !answersPrompt)
      ) {
        // This result belongs to queued background work, never to the prompt.
        // EOF or a refused command cannot turn it into a successful answer.
        return { turnEnded: false };
      }
      const candidate = {
        message,
        deferred: isDeferredResult(
          message,
          this.liveBackgroundTaskIds.size > 0
            || (!this.observedBackgroundTaskLevel && hasLiveTaskTrace),
        ),
      };
      this.latestResult = candidate;
      this.promptCompletedUnanswered = false;
      this.parentResumedAfterProvisional = false;
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
      // guaranteed by the SDK. Ambient watchers are explicitly not activity.
      this.liveBackgroundTaskIds = new Set(
        message.tasks
          .filter((task) => task.ambient !== true)
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
    if (this.promptFailure) return { kind: "incomplete", reason: this.promptFailure };
    const candidate = this.latestResult;
    if (!candidate) {
      return {
        kind: "incomplete",
        reason: this.promptCompletedUnanswered ? "prompt-unanswered" : "missing-result",
      };
    }
    if (!this.endedAtAuthoritativeIdle && this.liveBackgroundTaskIds.size > 0) {
      return { kind: "incomplete", reason: "delegates-abandoned" };
    }
    if (candidate.deferred) {
      return {
        kind: "incomplete",
        reason: this.parentResumedAfterProvisional ? "missing-result" : "parent-not-resumed",
      };
    }
    return { kind: "result", result: candidate.message };
  }

  dispose(): void {
    this.liveBackgroundTaskIds.clear();
    this.observedBackgroundTaskLevel = false;
    this.latestResult = undefined;
    this.endedAtAuthoritativeIdle = false;
    this.parentResumedAfterProvisional = false;
    this.promptPending = false;
    this.promptCompletedUnanswered = false;
    this.promptUuid = null;
    this.promptFailure = undefined;
  }

  awaitsUnansweredPrompt(): boolean {
    return this.promptCompletedUnanswered && !this.latestResult;
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
        && this.liveBackgroundTaskIds.size === 0)
      || (!this.observedBackgroundTaskLevel
        && hadLiveTaskTrace
        && !hasLiveTaskTrace)
    );
  }

  private canEndTurn(): boolean {
    return this.promptFailure !== undefined || (this.liveBackgroundTaskIds.size === 0
      && this.latestResult !== undefined
      && !this.latestResult.deferred);
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

export function isClaudeQueuedCompletionAck(result: SDKResultMessage): boolean {
  return result.subtype === "success"
    && !result.is_error
    && result.num_turns === 0
    && result.result === "";
}

export function isClaudeNotificationResult(result: SDKResultMessage): boolean {
  return claudeObjectValue(
    (result as { origin?: unknown }).origin,
  )?.kind === "task-notification";
}

export function isClaudeUnansweredPromptResult(
  result: SDKResultMessage,
  sawOutputText: boolean,
  compacting: boolean,
  promptText: string,
): boolean {
  return isClaudeQueuedCompletionAck(result)
    && (result as { local_command?: unknown }).local_command === undefined
    && !sawOutputText
    && !compacting
    && !promptText.trimStart().startsWith("/");
}

/** Only root work can release a bound armed after delegated work settled. */
export function claudeMessageResumesParent(
  message: SDKMessage,
  initialPromptId: string,
  pendingPromptIds: ReadonlySet<string>,
): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (record.parent_tool_use_id !== null && record.parent_tool_use_id !== undefined) return false;
  const command = claudeCommandLifecycleMessage(message);
  if (command) {
    return command.state === "started"
      && (command.command_uuid === initialPromptId || pendingPromptIds.has(command.command_uuid));
  }
  if (message.type === "assistant" || message.type === "stream_event" || message.type === "tool_progress") return true;
  if (message.type !== "system") return false;
  switch (message.subtype) {
    case "init":
    case "api_retry":
    case "thinking_tokens":
      return true;
    case "session_state_changed":
      return message.state === "running" || message.state === "requires_action";
    case "status":
      return message.status === "requesting" || message.status === "compacting";
    case "background_tasks_changed":
      return message.tasks.some((task) => task.ambient !== true);
    case "task_started":
      return message.ambient !== true && message.skip_transcript !== true;
    default:
      return false;
  }
}
