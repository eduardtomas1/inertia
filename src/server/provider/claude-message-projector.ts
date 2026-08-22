import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { providerActivityDetailSections } from "./activity-detail";
import type { AgentHarnessEmitter } from "./agent-harness";
import type { ProviderRunFailure } from "./contracts";
import { CappedProviderBuffer } from "./io";
import { parseClaudeRateLimitEvent, parseClaudeUsage } from "./claude-usage";
import {
  boundedClaudeEventText as bounded,
  boundedClaudeIdentifier as boundedIdentifier,
  boundedClaudeLabel as boundedLabel,
  BoundedStringMap,
  BoundedStringSet,
  claudeCommandLifecycleMessage as commandLifecycleMessage,
  claudeAssistantFailure,
  claudeDetailLines as detailLines,
  claudeObjectValue as objectValue,
  claudePlanSteps as planSteps,
  claudeTextItemId,
  ClaudeProjectedTextLedger,
  isChildOwnedClaudeMessage as isChildOwned,
  MAX_CLAUDE_TRACKED_MESSAGE_IDS as MAX_TRACKED_MESSAGE_IDS,
  MAX_CLAUDE_TRACKED_TEXT_ALIASES,
  safeClaudeNonNegativeNumber as safeNonNegativeNumber,
  safeClaudePositiveInteger as safePositiveInteger,
  safeClaudeStreamIndex as safeIndex,
  type ClaudeProjectedFailure,
  type ClaudeCommandLifecycleMessage,
} from "./claude-message-projector-support";
import { ClaudeMessageStreamCorrelation } from "./claude-message-stream-correlation";

export {
  MAX_CLAUDE_STREAM_CORRELATION_BLOCKS,
  MAX_CLAUDE_STREAM_CORRELATION_CHARS,
} from "./claude-message-projector-support";

type ClaudeSystemMessage = Extract<SDKMessage, { type: "system" }>;

interface ClaudeMessageProjectorOptions {
  emitter: AgentHarnessEmitter;
  text: CappedProviderBuffer;
  usesNativeAnthropic: boolean;
  selectedModelId?: string | null;
  contextWindowOverride?: number | null;
  contextUsage: () => unknown;
  acceptContextUsage: (usage: unknown) => void;
  refreshContextUsage: () => void;
}

interface ClaudeToolActivity {
  kind: "command" | "tool";
  label: string;
}


/**
 * Stateful, compile-time exhaustive projection of the exact Agent SDK message
 * union. Runtime-only frames from a newer Claude Code executable degrade to a
 * bounded notice instead of terminating the turn. Streaming deltas and their
 * later snapshots are reconciled by provider UUID/API message id so snapshots
 * can fill missing suffixes without replaying already-visible text or thinking.
 */
export class ClaudeMessageProjector {
  sawOutputText = false;
  compactSucceeded = false;
  compactFailure: string | undefined;
  hadSupersession = false;

  private readonly streams = new ClaudeMessageStreamCorrelation();
  private readonly seenAssistantMessages = new BoundedStringSet(
    MAX_TRACKED_MESSAGE_IDS,
  );
  private readonly seenUserMessages = new BoundedStringSet(
    MAX_TRACKED_MESSAGE_IDS,
  );
  private readonly completedToolActivities = new BoundedStringSet(
    MAX_TRACKED_MESSAGE_IDS,
  );
  private readonly projectedPlanToolUses = new BoundedStringSet(
    MAX_TRACKED_MESSAGE_IDS,
  );
  private readonly toolActivities = new Map<string, ClaudeToolActivity>();
  private readonly assistantFailures = new Map<string, ClaudeProjectedFailure>();
  private readonly projectedText = new ClaudeProjectedTextLedger();
  private readonly unknownRuntimeMessages = new BoundedStringSet(256);
  private readonly textItemByProviderMessageId = new BoundedStringMap<string>(
    MAX_CLAUDE_TRACKED_TEXT_ALIASES,
  );
  private uncorrelatedFailure: ClaudeProjectedFailure | undefined;
  private pendingWorkerShutdown: ClaudeProjectedFailure | undefined;
  private activeProviderStatus: "compacting" | "requesting" | null = null;
  private thinkingProgressActive = false;

  constructor(private readonly options: ClaudeMessageProjectorOptions) {}

  observe(message: SDKMessage, provesRequestedCompaction: boolean): void {
    const commandLifecycle = commandLifecycleMessage(message);
    if (commandLifecycle) {
      this.observeCommandLifecycle(commandLifecycle);
      return;
    }
    if (!(
      message.type === "system"
      && message.subtype === "worker_shutting_down"
    )) {
      // The SDK documents worker_shutting_down as a live-tail hint. Any later
      // event proves that a replayed or transient notice was not terminal.
      this.pendingWorkerShutdown = undefined;
    }

    switch (message.type) {
      case "assistant":
        this.observeAssistant(message);
        return;
      case "user":
        this.observeUser(message);
        return;
      case "stream_event":
        this.observeStreamEvent(message);
        return;
      case "result":
        this.observeResult(message);
        return;
      case "rate_limit_event":
        if (this.options.usesNativeAnthropic) {
          const rateLimit = parseClaudeRateLimitEvent(message);
          if (rateLimit) {
            this.options.emitter.rich({
              type: "metadata",
              metadata: { rateLimits: [rateLimit] },
              source: "session",
              complete: false,
            });
          }
        }
        return;
      case "tool_progress":
        this.observeToolProgress(message);
        return;
      case "tool_use_summary":
        this.options.emitter.activity("tool", "info", "Claude tool summary", {
          detail: detailLines([message.summary]),
        });
        return;
      case "auth_status":
        this.observeAuthStatus(message);
        return;
      case "prompt_suggestion":
        // Prompt suggestions have no truthful neutral interaction contract.
        // They must not be injected into the assistant transcript as output.
        return;
      case "conversation_reset":
        this.resetConversationCorrelation();
        // A reset invalidates any text accumulated before the new
        // conversation. The neutral text channel is append-only, so the
        // harness must use the terminal result as its authoritative snapshot.
        this.hadSupersession = true;
        this.options.emitter.textSnapshot(
          this.textItemId("reset", message.new_conversation_id),
          "",
        );
        this.options.emitter.activity(
          "system",
          "info",
          "Claude started a new conversation",
        );
        return;
      case "system":
        this.observeSystem(message, provesRequestedCompaction);
        return;
      default: {
        const exhaustive: never = message;
        this.observeUnknownRuntimeMessage("message", exhaustive);
      }
    }
  }

  resetTurnOutput(): void {
    this.sawOutputText = false;
    this.hadSupersession = false;
    this.projectedText.seal();
    this.textItemByProviderMessageId.clear();
  }

  authoritativeText(): string {
    return this.projectedText.snapshot();
  }

  emitTerminalText(value: string, providerMessageId: string): void {
    this.emitText(value, this.textItemId("result", providerMessageId));
  }

  preferredFailure(): ProviderRunFailure | undefined {
    const candidate = this.pendingWorkerShutdown
      ?? this.uncorrelatedFailure
      ?? [...this.assistantFailures.values()].at(-1);
    if (!candidate) return undefined;
    return {
      reason: "provider-error",
      message: candidate.message,
      phase: "turn",
      terminalEvent: candidate.terminalEvent,
      ...(candidate.activityId ? { activityId: candidate.activityId } : {}),
    };
  }

  private observeStreamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>,
  ): void {
    if (isChildOwned(message.parent_tool_use_id)) return;
    const event = message.event;
    const sessionId = boundedIdentifier(message.session_id);
    const sdkUuid = boundedIdentifier(message.uuid);
    const apiMessageId = event.type === "message_start"
      ? boundedIdentifier(objectValue(event.message)?.id)
      : undefined;
    switch (event.type) {
      case "message_start":
        this.streams.state(sessionId, sdkUuid, apiMessageId);
        return;
      case "content_block_start": {
        const block = objectValue(event.content_block);
        if (block) this.observeToolStart(block);
        return;
      }
      case "content_block_delta": {
        const state = this.streams.state(sessionId, sdkUuid, undefined);
        const index = safeIndex(event.index);
        if (index === null) return;
        switch (event.delta.type) {
          case "text_delta":
            if (!event.delta.text) return;
            this.streams.appendDelta(
              state,
              index,
              "text",
              event.delta.text,
            );
            if (sdkUuid) {
              this.textItemByProviderMessageId.set(
                sdkUuid,
                state.textItemId,
              );
            }
            if (state.apiMessageId) {
              this.textItemByProviderMessageId.set(
                state.apiMessageId,
                state.textItemId,
              );
            }
            this.closeThinkingProgress();
            this.emitText(event.delta.text, state.textItemId);
            return;
          case "thinking_delta":
            if (!event.delta.thinking) return;
            this.streams.appendDelta(
              state,
              index,
              "thinking",
              event.delta.thinking,
            );
            this.emitReasoning(event.delta.thinking);
            return;
          case "citations_delta":
          case "compaction_delta":
          case "input_json_delta":
          case "signature_delta":
            return;
          default: {
            const exhaustive: never = event.delta;
            this.observeUnknownRuntimeMessage("stream delta", exhaustive);
            return;
          }
        }
      }
      case "content_block_stop":
      case "message_delta":
      case "message_stop":
        return;
      default: {
        const exhaustive: never = event;
        this.observeUnknownRuntimeMessage("stream event", exhaustive);
      }
    }
  }

  private observeAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): void {
    if (isChildOwned(message.parent_tool_use_id)) return;
    const uuid = boundedIdentifier(message.uuid);
    const apiMessageId = boundedIdentifier(message.message.id);
    const identity = uuid ?? (apiMessageId ? `api:${apiMessageId}` : undefined);
    if (identity && this.seenAssistantMessages.has(identity)) return;

    let correctedText = false;
    for (const superseded of message.supersedes ?? []) {
      const id = boundedIdentifier(superseded);
      if (!id) continue;
      correctedText = this.projectedText.remove(
        this.resolveTextItemId(id),
      ) || correctedText;
      this.assistantFailures.delete(id);
      this.streams.remove(id);
    }
    if ((message.supersedes?.length ?? 0) > 0) {
      this.hadSupersession = true;
      this.options.emitter.activity(
        "system",
        "info",
        "Claude replaced an earlier response",
      );
    }

    const stream = this.streams.forAssistant(
      message,
      apiMessageId,
      (message.supersedes?.length ?? 0) > 0,
    );
    const textItemId = stream?.textItemId
      ?? this.textItemId("message", uuid ?? apiMessageId ?? "assistant");
    const snapshotText = message.message.content.flatMap((value) => {
      const item = objectValue(value);
      return item?.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    }).join("");
    const streamedText = stream
      ? [...stream.blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => block.text)
        .join("")
      : "";
    if (snapshotText || streamedText) {
      if (uuid) this.textItemByProviderMessageId.set(uuid, textItemId);
      if (apiMessageId) {
        this.textItemByProviderMessageId.set(apiMessageId, textItemId);
      }
    }
    const streamCanAuthoritativelyCorrect = Boolean(
      stream
      && (
        (stream.apiMessageId !== null
          && stream.apiMessageId === apiMessageId)
        || (uuid !== undefined
          && (stream.key === `sdk:${uuid}` || stream.key === uuid))
      ),
    );
    const snapshotCorrectedStream = Boolean(
      streamCanAuthoritativelyCorrect
      && streamedText
      && !snapshotText.startsWith(streamedText),
    );
    if (snapshotCorrectedStream) {
      this.projectedText.replace(textItemId, snapshotText);
      correctedText = true;
      this.hadSupersession = true;
    } else if (snapshotText.startsWith(streamedText)) {
      this.emitText(snapshotText.slice(streamedText.length), textItemId);
    }
    for (let index = 0; index < message.message.content.length; index += 1) {
      const item = objectValue(message.message.content[index]);
      if (!item) continue;
      const streamed = stream?.blocks.get(index);
      if (item.type === "text" && typeof item.text === "string") {
        continue;
      } else if (item.type === "thinking" && typeof item.thinking === "string") {
        this.emitReasoningSnapshotSuffix(
          item.thinking,
          streamed?.thinking ?? "",
        );
      } else if (item.type === "tool_use" || item.type === "server_tool_use") {
        this.observeToolStart(item);
      } else if (
        typeof item.type === "string"
        && item.type.endsWith("_tool_result")
      ) {
        this.observeAssistantToolResult(item);
      }
    }
    if (correctedText) {
      this.options.emitter.textSnapshot(
        textItemId,
        this.projectedText.snapshot(),
      );
    }

    if (message.context_usage !== undefined) {
      this.options.acceptContextUsage(message.context_usage);
    } else {
      this.options.refreshContextUsage();
    }
    this.closeThinkingProgress();
    if (message.error) {
      const failure = claudeAssistantFailure(message.error, uuid);
      if (uuid) this.rememberAssistantFailure(uuid, failure);
      else this.uncorrelatedFailure = failure;
      this.options.emitter.activity(
        "system",
        message.resumed_from_incomplete_thinking === true ? "info" : "failed",
        message.resumed_from_incomplete_thinking === true
          ? "Claude continued a truncated response"
          : "Claude response issue",
        {
          ...(uuid ? { activityId: uuid } : {}),
          detail: detailLines([`Error: ${message.error}`]),
        },
      );
    }
    if (message.aborted === true) {
      if (!message.error) {
        const failure: ClaudeProjectedFailure = {
          message: "Claude's response was interrupted before completion.",
          terminalEvent: "assistant/aborted",
          ...(uuid ? { activityId: uuid } : {}),
        };
        if (uuid) this.rememberAssistantFailure(uuid, failure);
        else this.uncorrelatedFailure = failure;
      }
      this.options.emitter.activity(
        "system",
        "failed",
        "Claude response was interrupted",
        uuid ? { activityId: uuid } : undefined,
      );
    }
    if (identity) this.seenAssistantMessages.add(identity);
    if (stream) this.streams.remove(stream.key);
  }

  private observeUser(message: Extract<SDKMessage, { type: "user" }>): void {
    if (
      isChildOwned(message.parent_tool_use_id)
      || ("isReplay" in message && message.isReplay === true)
    ) return;
    const uuid = boundedIdentifier(message.uuid);
    if (uuid && this.seenUserMessages.has(uuid)) return;
    const content = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    for (const block of content) {
      const result = objectValue(block);
      if (result?.type !== "tool_result") continue;
      this.observeToolResult(result);
    }
    if (uuid) this.seenUserMessages.add(uuid);
  }

  private observeResult(message: Extract<SDKMessage, { type: "result" }>): void {
    this.closeProviderStatus();
    this.closeThinkingProgress();
    const usage = parseClaudeUsage(message, {
      selectedModelId: this.options.selectedModelId,
      contextWindowOverride: this.options.contextWindowOverride,
      contextUsage: this.options.contextUsage(),
    });
    if (usage) this.options.emitter.rich({ type: "usage", usage });
    for (const denial of message.permission_denials ?? []) {
      this.observePermissionDenial({
        tool_name: denial.tool_name,
        tool_use_id: denial.tool_use_id,
        message: "Claude denied this tool request.",
      });
    }
  }

  private observeToolProgress(
    message: Extract<SDKMessage, { type: "tool_progress" }>,
  ): void {
    if (isChildOwned(message.parent_tool_use_id)) return;
    const activityId = boundedIdentifier(message.tool_use_id);
    if (!activityId || this.completedToolActivities.has(activityId)) return;
    const name = boundedLabel(message.tool_name, "Tool");
    const existing = this.toolActivities.get(activityId);
    const kind = existing?.kind ?? (name === "Bash" ? "command" : "tool");
    const label = existing?.label ?? name;
    if (!existing) this.rememberToolActivity(activityId, { kind, label });
    const retry = message.subagent_retry;
    this.options.emitter.activity(kind, "started", label, {
      activityId,
      detail: detailLines([
        `Elapsed: ${safeNonNegativeNumber(message.elapsed_time_seconds)} seconds`,
        retry
          ? `Retry: ${safePositiveInteger(retry.attempt)}/${safePositiveInteger(retry.max_retries)}`
          : null,
        retry ? `Retry delay: ${safeNonNegativeNumber(retry.retry_delay_ms)} ms` : null,
        retry ? `Error category: ${boundedLabel(retry.error_category, "unknown")}` : null,
      ]),
    });
  }

  private observeAuthStatus(
    message: Extract<SDKMessage, { type: "auth_status" }>,
  ): void {
    const activityId = "claude:authentication";
    const detail = detailLines(message.output);
    if (message.isAuthenticating) {
      if (this.uncorrelatedFailure?.terminalEvent === "auth_status/error") {
        this.uncorrelatedFailure = undefined;
      }
      this.options.emitter.activity(
        "system",
        "started",
        "Claude is authenticating",
        { activityId, ...(detail ? { detail } : {}) },
      );
      return;
    }
    if (message.error) {
      this.uncorrelatedFailure = {
        message: "Claude authentication failed.",
        terminalEvent: "auth_status/error",
        activityId,
      };
      this.options.emitter.activity(
        "system",
        "failed",
        "Claude authentication failed",
        {
          activityId,
          detail: detailLines([message.error, ...message.output]),
        },
      );
      return;
    }
    if (this.uncorrelatedFailure?.terminalEvent === "auth_status/error") {
      this.uncorrelatedFailure = undefined;
    }
    this.options.emitter.activity(
      "system",
      "completed",
      "Claude authenticated",
      { activityId, ...(detail ? { detail } : {}) },
    );
  }

  private observeCommandLifecycle(message: ClaudeCommandLifecycleMessage): void {
    const activityId = boundedIdentifier(message.command_uuid);
    if (!activityId) {
      this.observeUnknownRuntimeMessage("command lifecycle", message);
      return;
    }
    const phase = message.state === "queued" || message.state === "started"
      ? "started"
      : message.state === "completed"
        ? "completed"
        : "info";
    const label = message.state === "queued"
      ? "Claude queued the request"
      : message.state === "started"
        ? "Claude started the request"
        : message.state === "completed"
          ? "Claude completed the request"
          : message.state === "cancelled"
            ? "Claude cancelled the request"
            : "Claude discarded the request";
    this.options.emitter.activity("system", phase, label, {
      activityId: `claude:command:${activityId}`,
      detail: `State: ${message.state}`,
    });
  }

  private observeSystem(
    message: ClaudeSystemMessage,
    provesRequestedCompaction: boolean,
  ): void {
    switch (message.subtype) {
      case "init":
        // Session/model/skill attestation is handled by the harness control
        // path. Replaying it as transcript activity would add no user detail.
        return;
      case "status":
        this.observeStatus(message, provesRequestedCompaction);
        return;
      case "compact_boundary":
        if (
          provesRequestedCompaction
          && message.compact_metadata.trigger === "manual"
          && !this.compactFailure
        ) this.compactSucceeded = true;
        this.options.refreshContextUsage();
        this.options.emitter.activity(
          "system",
          "completed",
          "Claude compacted context",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Trigger: ${message.compact_metadata.trigger}`,
              `Before: ${safeNonNegativeNumber(message.compact_metadata.pre_tokens)} tokens`,
              message.compact_metadata.post_tokens === undefined
                ? null
                : `After: ${safeNonNegativeNumber(message.compact_metadata.post_tokens)} tokens`,
              message.compact_metadata.duration_ms === undefined
                ? null
                : `Duration: ${safeNonNegativeNumber(message.compact_metadata.duration_ms)} ms`,
            ]),
          },
        );
        return;
      case "api_retry":
        this.options.emitter.status("retrying", undefined, `system/api_retry attempt ${safePositiveInteger(message.attempt)}`);
        this.options.emitter.activity(
          "system",
          "info",
          `Claude API retry ${safePositiveInteger(message.attempt)}/${safePositiveInteger(message.max_retries)}`,
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Error: ${message.error}`,
              message.error_status === null
                ? "HTTP status: connection error"
                : `HTTP status: ${safeNonNegativeNumber(message.error_status)}`,
              `Retry delay: ${safeNonNegativeNumber(message.retry_delay_ms)} ms`,
            ]),
          },
        );
        return;
      case "control_request_progress":
        if (message.status === "api_retry") {
          this.options.emitter.status("retrying", undefined, `control_request/api_retry attempt ${safePositiveInteger(message.attempt)}`);
        }
        this.options.emitter.activity(
          "system",
          "info",
          message.status === "api_retry"
            ? "Claude control request is retrying"
            : "Claude control request started",
          {
            activityId: boundedIdentifier(message.request_id),
            detail: message.status === "api_retry"
              ? detailLines([
                  `Attempt: ${safePositiveInteger(message.attempt)}/${safePositiveInteger(message.max_retries)}`,
                  `Retry delay: ${safeNonNegativeNumber(message.retry_delay_ms)} ms`,
                  message.error_status === null
                    ? "HTTP status: connection error"
                    : message.error_status === undefined
                      ? null
                      : `HTTP status: ${safeNonNegativeNumber(message.error_status)}`,
                ])
              : undefined,
          },
        );
        return;
      case "model_refusal_fallback":
        if (message.scope !== "local") {
          if (
            this.uncorrelatedFailure?.terminalEvent
            === "system/model_refusal_no_fallback"
          ) this.uncorrelatedFailure = undefined;
          let correctedText = false;
          for (const retracted of message.retracted_message_uuids ?? []) {
            const id = boundedIdentifier(retracted);
            if (!id) continue;
            correctedText = this.projectedText.remove(
              this.resolveTextItemId(id),
            ) || correctedText;
            this.assistantFailures.delete(id);
            this.streams.remove(id);
          }
          this.hadSupersession = true;
          if (correctedText) {
            this.options.emitter.textSnapshot(
              this.textItemId("fallback", message.uuid),
              this.projectedText.snapshot(),
            );
          }
        }
        this.options.emitter.activity(
          "system",
          "info",
          message.scope === "local"
            ? "A Claude worker used a fallback model"
            : "Claude switched to a fallback model",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Original model: ${boundedLabel(message.original_model, "unknown")}`,
              `Fallback model: ${boundedLabel(message.fallback_model, "unknown")}`,
              message.api_refusal_category
                ? `Refusal category: ${boundedLabel(message.api_refusal_category, "unknown")}`
                : null,
              message.api_refusal_explanation,
              message.content,
            ]),
          },
        );
        return;
      case "model_refusal_no_fallback":
        this.uncorrelatedFailure = {
          message: "Claude refused the response and no fallback model was available.",
          terminalEvent: "system/model_refusal_no_fallback",
          activityId: boundedIdentifier(message.uuid),
        };
        this.options.emitter.activity(
          "system",
          "failed",
          "Claude response was refused",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Model: ${boundedLabel(message.original_model, "unknown")}`,
              message.api_refusal_category
                ? `Category: ${boundedLabel(message.api_refusal_category, "unknown")}`
                : null,
              message.api_refusal_explanation,
              message.content,
            ]),
          },
        );
        return;
      case "local_command_output":
        this.emitText(
          message.content,
          this.textItemId("local-command", message.uuid),
        );
        return;
      case "hook_started":
        this.options.emitter.activity("tool", "started", "Claude hook", {
          activityId: boundedIdentifier(message.hook_id),
          detail: detailLines([
            `Hook: ${boundedLabel(message.hook_name, "unknown")}`,
            `Event: ${boundedLabel(message.hook_event, "unknown")}`,
          ]),
        });
        return;
      case "hook_progress":
        this.options.emitter.activity("tool", "started", "Claude hook", {
          activityId: boundedIdentifier(message.hook_id),
          detail: detailLines([
            message.output,
            message.stdout,
            message.stderr,
          ]),
        });
        return;
      case "hook_response":
        this.options.emitter.activity(
          "tool",
          message.outcome === "success" ? "completed" : "failed",
          "Claude hook",
          {
            activityId: boundedIdentifier(message.hook_id),
            detail: detailLines([
              message.output,
              message.stdout,
              message.stderr,
              message.exit_code === undefined
                ? null
                : `Exit code: ${safeNonNegativeNumber(message.exit_code)}`,
            ]),
          },
        );
        return;
      case "plugin_install": {
        const activityId = `claude:plugin:${boundedIdentifier(message.name) ?? "all"}`;
        const label = message.name
          ? `Claude plugin · ${boundedLabel(message.name, "plugin")}`
          : "Claude plugins";
        const phase = message.status === "started"
          ? "started"
          : message.status === "failed"
            ? "failed"
            : "completed";
        this.options.emitter.activity("system", phase, label, {
          activityId,
          detail: message.error ? detailLines([message.error]) : undefined,
        });
        return;
      }
      case "task_started":
      case "task_progress":
      case "task_updated":
      case "task_notification":
      case "background_tasks_changed":
        // The typed subagent tracker and delegate lifecycle own these events.
        return;
      case "thinking_tokens":
        this.thinkingProgressActive = true;
        this.options.emitter.activity(
          "reasoning",
          "started",
          "Claude is thinking",
          {
            activityId: "claude:thinking-progress",
            detail: detailLines([
              `Estimated tokens: ${safeNonNegativeNumber(message.estimated_tokens)}`,
            ]),
          },
        );
        return;
      case "session_state_changed":
        if (message.state === "running") {
          this.options.emitter.status("running", "Claude is working.");
        } else if (message.state === "requires_action") {
          this.options.emitter.activity(
            "system",
            "info",
            "Claude requires input",
          );
        } else {
          this.closeProviderStatus();
          this.closeThinkingProgress();
        }
        return;
      case "worker_shutting_down":
        this.pendingWorkerShutdown = {
          message: "Claude's worker stopped before the request completed.",
          terminalEvent: "system/worker_shutting_down",
          activityId: boundedIdentifier(message.uuid),
        };
        this.options.emitter.activity(
          "system",
          "info",
          "Claude worker is shutting down",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Reason: ${boundedLabel(message.reason, "unknown")}`,
            ]),
          },
        );
        return;
      case "commands_changed":
        // Commands are refreshed through the SDK query API; there is no
        // neutral per-run command-list event to publish.
        return;
      case "notification":
        this.options.emitter.activity(
          "system",
          "info",
          message.priority === "high" || message.priority === "immediate"
            ? "Claude notification"
            : "Claude notice",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([message.text]),
          },
        );
        return;
      case "files_persisted":
        this.options.emitter.activity(
          "system",
          message.failed.length > 0 ? "failed" : "completed",
          message.failed.length > 0
            ? "Claude could not persist some files"
            : "Claude persisted files",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              ...message.files.slice(0, 16).map((file) => `Saved: ${file.filename}`),
              ...message.failed.slice(0, 16).map(
                (file) => `Failed: ${file.filename} · ${file.error}`,
              ),
            ]),
          },
        );
        return;
      case "memory_recall": {
        const scopes = [...new Set(message.memories.map((memory) => memory.scope))];
        this.options.emitter.activity(
          "system",
          "info",
          "Claude recalled memory",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([
              `Mode: ${message.mode}`,
              `Memories: ${message.memories.length}`,
              scopes.length > 0 ? `Scopes: ${scopes.join(", ")}` : null,
            ]),
          },
        );
        return;
      }
      case "elicitation_complete":
        this.options.emitter.activity(
          "tool",
          "completed",
          "Claude MCP request completed",
          {
            activityId: boundedIdentifier(message.elicitation_id),
            detail: detailLines([
              `Server: ${boundedLabel(message.mcp_server_name, "MCP")}`,
            ]),
          },
        );
        return;
      case "permission_denied":
        if (!message.agent_id) this.observePermissionDenial(message);
        return;
      case "mirror_error":
        this.options.emitter.activity(
          "system",
          "failed",
          "Claude transcript mirror failed",
          {
            activityId: boundedIdentifier(message.uuid),
            detail: detailLines([message.error]),
          },
        );
        return;
      case "informational":
        if (message.prevent_continuation === true) {
          this.uncorrelatedFailure = {
            message: "Claude stopped after reporting a blocking notice.",
            terminalEvent: "system/informational",
            activityId: boundedIdentifier(message.uuid),
          };
        }
        this.options.emitter.activity(
          "system",
          message.prevent_continuation === true ? "failed" : "info",
          message.level === "warning"
            ? "Claude warning"
            : message.level === "suggestion"
              ? "Claude suggestion"
              : "Claude notice",
          {
            activityId: boundedIdentifier(message.tool_use_id)
              ?? boundedIdentifier(message.uuid),
            detail: detailLines([message.content]),
          },
        );
        return;
      default: {
        const exhaustive: never = message;
        this.observeUnknownRuntimeMessage("system message", exhaustive);
      }
    }
  }

  private observeUnknownRuntimeMessage(scope: string, value: unknown): void {
    const record = objectValue(value);
    const discriminator = (candidate: unknown): string =>
      typeof candidate === "string"
      && /^[A-Za-z0-9_.:/-]{1,120}$/u.test(candidate)
        ? candidate
        : "unknown";
    const type = discriminator(record?.type);
    const subtype = discriminator(record?.subtype);
    const state = discriminator(record?.state);
    const event = objectValue(record?.event);
    const eventType = discriminator(event?.type);
    const deltaType = discriminator(objectValue(event?.delta)?.type);
    const signature = [scope, type, subtype, state, eventType, deltaType].join(":");
    if (this.unknownRuntimeMessages.has(signature)) return;
    this.unknownRuntimeMessages.add(signature);
    this.options.emitter.activity(
      "system",
      "info",
      "Claude sent an unsupported SDK update",
      {
        detail: detailLines([
          `Scope: ${scope}`,
          `Type: ${type}`,
          record
            ? `Fields: ${Object.keys(record)
              .filter((key) => /^[A-Za-z0-9_.:/-]{1,120}$/u.test(key))
              .slice(0, 32)
              .join(", ")}`
            : null,
          subtype !== "unknown" ? `Subtype: ${subtype}` : null,
          state !== "unknown" ? `State: ${state}` : null,
          eventType !== "unknown" ? `Event: ${eventType}` : null,
          deltaType !== "unknown" ? `Delta: ${deltaType}` : null,
        ]),
      },
    );
  }

  private observeStatus(
    message: Extract<ClaudeSystemMessage, { subtype: "status" }>,
    provesRequestedCompaction: boolean,
  ): void {
    if (
      provesRequestedCompaction
      && message.compact_result === "success"
      && !this.compactFailure
    ) this.compactSucceeded = true;
    if (provesRequestedCompaction && message.compact_result === "failed") {
      this.compactSucceeded = false;
      this.compactFailure = message.compact_error?.trim()
        || "Claude reported that context compaction failed.";
    }
    if (message.compact_result === "failed") {
      this.options.emitter.activity(
        "system",
        "failed",
        "Claude context compaction failed",
        {
          activityId: boundedIdentifier(message.uuid),
          detail: detailLines([message.compact_error]),
        },
      );
    }
    if (
      message.status !== "compacting"
      && message.status !== "requesting"
      && message.status !== null
    ) return;
    if (message.status === this.activeProviderStatus) return;
    this.closeProviderStatus();
    if (message.status === null) return;
    this.activeProviderStatus = message.status;
    this.options.emitter.activity(
      "system",
      "started",
      message.status === "compacting"
        ? "Claude is compacting context"
        : "Claude is requesting a response",
      { activityId: `claude:status:${message.status}` },
    );
  }

  private closeProviderStatus(): void {
    if (!this.activeProviderStatus) return;
    const status = this.activeProviderStatus;
    this.activeProviderStatus = null;
    this.options.emitter.activity(
      "system",
      "completed",
      status === "compacting"
        ? "Claude compacted context"
        : "Claude received a response",
      { activityId: `claude:status:${status}` },
    );
  }

  private closeThinkingProgress(): void {
    if (!this.thinkingProgressActive) return;
    this.thinkingProgressActive = false;
    this.options.emitter.activity(
      "reasoning",
      "completed",
      "Claude finished thinking",
      { activityId: "claude:thinking-progress" },
    );
  }

  private observePermissionDenial(message: {
    tool_name: string;
    tool_use_id: string;
    message: string;
    decision_reason?: string;
    decision_reason_type?: string;
  }): void {
    const activityId = boundedIdentifier(message.tool_use_id);
    if (!activityId || this.completedToolActivities.has(activityId)) return;
    const activity = this.toolActivities.get(activityId);
    this.options.emitter.activity(
      activity?.kind ?? "tool",
      "failed",
      activity?.label ?? boundedLabel(message.tool_name, "Tool"),
      {
        activityId,
        detail: providerActivityDetailSections({
          error: detailLines([
            message.decision_reason,
            message.decision_reason_type
              ? `Decision: ${message.decision_reason_type}`
              : null,
            message.message,
          ]),
        }) ?? undefined,
      },
    );
    this.toolActivities.delete(activityId);
    this.completedToolActivities.add(activityId);
  }

  private observeToolStart(item: Record<string, unknown>): void {
    const activityId = boundedIdentifier(item.id);
    const name = boundedLabel(item.name, "Tool");
    const input = objectValue(item.input);
    if (
      name === "ExitPlanMode"
      && (!activityId || !this.projectedPlanToolUses.has(activityId))
    ) {
      const plan = typeof input?.plan === "string"
        ? input.plan
        : typeof input?.content === "string"
          ? input.content
          : undefined;
      if (plan) {
        this.options.emitter.rich({
          type: "plan",
          explanation: bounded(plan),
          steps: planSteps(plan),
        });
        if (activityId) this.projectedPlanToolUses.add(activityId);
      }
    }
    if (activityId && (
      this.completedToolActivities.has(activityId)
      || this.toolActivities.has(activityId)
    )) return;
    const kind = name === "Bash" ? "command" : "tool";
    const label = name;
    if (activityId) this.rememberToolActivity(activityId, { kind, label });
    this.options.emitter.activity(kind, "started", label, {
      ...(activityId ? { activityId } : {}),
      ...(name === "Bash"
        ? {
            detail: providerActivityDetailSections({
              command: input?.command,
            }) ?? undefined,
          }
        : {}),
    });
  }

  private observeToolResult(result: Record<string, unknown>): void {
    const activityId = boundedIdentifier(result.tool_use_id);
    if (!activityId || this.completedToolActivities.has(activityId)) return;
    const activity = this.toolActivities.get(activityId);
    // Replayed history and malformed out-of-order results must not create
    // ghost transcript activities without a matching provider tool call.
    if (!activity) return;
    const failed = result.is_error === true;
    const detail = providerActivityDetailSections({
      [failed ? "error" : "output"]: result.content,
    });
    this.options.emitter.activity(
      activity.kind,
      failed ? "failed" : "completed",
      activity.label,
      {
        activityId,
        ...(detail ? { detail } : {}),
      },
    );
    this.toolActivities.delete(activityId);
    this.completedToolActivities.add(activityId);
  }

  private observeAssistantToolResult(result: Record<string, unknown>): void {
    const activityId = boundedIdentifier(
      result.tool_use_id ?? result.server_tool_use_id,
    );
    if (!activityId || this.completedToolActivities.has(activityId)) return;
    const activity = this.toolActivities.get(activityId);
    if (!activity) return;
    const failed = result.is_error === true;
    this.options.emitter.activity(
      activity.kind,
      failed ? "failed" : "completed",
      activity.label,
      {
        activityId,
        detail: providerActivityDetailSections({
          [failed ? "error" : "output"]: result.content,
        }) ?? undefined,
      },
    );
    this.toolActivities.delete(activityId);
    this.completedToolActivities.add(activityId);
  }

  private rememberToolActivity(
    activityId: string,
    activity: ClaudeToolActivity,
  ): void {
    this.toolActivities.set(activityId, activity);
    if (this.toolActivities.size <= MAX_TRACKED_MESSAGE_IDS) return;
    const oldest = this.toolActivities.keys().next().value;
    if (typeof oldest === "string") this.toolActivities.delete(oldest);
  }

  private rememberAssistantFailure(
    activityId: string,
    failure: ClaudeProjectedFailure,
  ): void {
    if (this.assistantFailures.delete(activityId)) {
      this.assistantFailures.set(activityId, failure);
      return;
    }
    this.assistantFailures.set(activityId, failure);
    if (this.assistantFailures.size <= MAX_TRACKED_MESSAGE_IDS) return;
    const oldest = this.assistantFailures.keys().next().value;
    if (typeof oldest === "string") this.assistantFailures.delete(oldest);
  }

  private emitReasoningSnapshotSuffix(
    snapshot: string,
    streamed: string,
  ): void {
    if (!snapshot) return;
    if (!streamed) {
      this.emitReasoning(snapshot);
      return;
    }
    if (snapshot.startsWith(streamed)) {
      const suffix = snapshot.slice(streamed.length);
      this.emitReasoning(suffix);
      return;
    }
    // Reasoning has no persisted replacement channel. Dropping a non-prefix
    // snapshot avoids displaying both stale and corrected thinking.
  }

  private emitText(value: string, itemId: string): void {
    if (!value) return;
    const safe = bounded(value);
    const accepted = this.projectedText.append(itemId, safe);
    this.options.text.append(safe);
    if (!accepted) return;
    this.sawOutputText = true;
    this.options.emitter.text(accepted, itemId);
  }

  private emitReasoning(value: string): void {
    if (!value) return;
    this.options.emitter.rich({
      type: "reasoning-summary",
      text: bounded(value),
    });
  }

  private textItemId(kind: string, value: string): string {
    return claudeTextItemId(kind, value);
  }

  private resolveTextItemId(providerMessageId: string): string {
    const mapped = this.textItemByProviderMessageId.get(providerMessageId);
    if (mapped) return mapped;
    return this.streams.resolveTextItemId(providerMessageId)
      ?? this.textItemId("message", providerMessageId);
  }

  private resetConversationCorrelation(): void {
    this.streams.reset();
    this.seenAssistantMessages.clear();
    this.seenUserMessages.clear();
    this.completedToolActivities.clear();
    this.projectedPlanToolUses.clear();
    this.toolActivities.clear();
    this.assistantFailures.clear();
    this.projectedText.reset();
    this.textItemByProviderMessageId.clear();
    this.uncorrelatedFailure = undefined;
    this.pendingWorkerShutdown = undefined;
    this.sawOutputText = false;
    this.hadSupersession = false;
    this.closeProviderStatus();
    this.closeThinkingProgress();
  }
}
