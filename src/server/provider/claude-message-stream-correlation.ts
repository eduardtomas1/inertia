import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  boundedClaudeIdentifier,
  claudeTextItemId,
  MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS,
  MAX_CLAUDE_STREAM_CORRELATION_BLOCKS,
  MAX_CLAUDE_STREAM_CORRELATION_CHARS,
  MAX_CLAUDE_STREAM_STATES,
} from "./claude-message-projector-support";

export interface ClaudeStreamBlock {
  text: string;
  thinking: string;
}

export interface ClaudeStreamState {
  key: string;
  textItemId: string;
  apiMessageId: string | null;
  sessionId: string | null;
  blocks: Map<number, ClaudeStreamBlock>;
}

/**
 * Bounded correlation for Claude's partial stream frames and later
 * authoritative assistant snapshots.
 */
export class ClaudeMessageStreamCorrelation {
  private readonly states = new Map<string, ClaudeStreamState>();
  private readonly keyByApiMessageId = new Map<string, string>();
  private readonly currentKeyBySession = new Map<string, string>();
  private retainedBlocks = 0;
  private retainedChars = 0;

  state(
    sessionId: string | undefined,
    sdkUuid: string | undefined,
    apiMessageId: string | undefined,
  ): ClaudeStreamState {
    const currentKey = sessionId
      ? this.currentKeyBySession.get(sessionId)
      : undefined;
    const apiKey = apiMessageId
      ? this.keyByApiMessageId.get(apiMessageId)
      : undefined;
    const existingKey = apiKey ?? (apiMessageId ? undefined : currentKey);
    if (existingKey) {
      const existing = this.states.get(existingKey);
      if (existing) return existing;
    }
    const key = apiMessageId
      ? `api:${apiMessageId}`
      : sdkUuid
        ? `sdk:${sdkUuid}`
        : `legacy:${sessionId ?? "session"}`;
    const state: ClaudeStreamState = {
      key,
      textItemId: claudeTextItemId("stream", key),
      apiMessageId: apiMessageId ?? null,
      sessionId: sessionId ?? null,
      blocks: new Map(),
    };
    this.states.set(key, state);
    if (apiMessageId) this.keyByApiMessageId.set(apiMessageId, key);
    if (sessionId) this.currentKeyBySession.set(sessionId, key);
    while (this.states.size > MAX_CLAUDE_STREAM_STATES) {
      const oldest = this.states.keys().next().value;
      if (typeof oldest !== "string") break;
      this.remove(oldest);
    }
    return state;
  }

  forAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
    apiMessageId: string | undefined,
    supersedesEarlierMessage: boolean,
  ): ClaudeStreamState | undefined {
    const byApi = apiMessageId
      ? this.keyByApiMessageId.get(apiMessageId)
      : undefined;
    if (byApi) return this.states.get(byApi);
    const sessionId = boundedClaudeIdentifier(message.session_id);
    const current = sessionId
      ? this.currentKeyBySession.get(sessionId)
      : undefined;
    if (current) {
      const state = this.states.get(current);
      // Older partial frames can omit message_start. A current-session
      // fallback is unsafe when either side identifies a different message.
      if (
        state
        && !supersedesEarlierMessage
        && (!state.apiMessageId || !apiMessageId
          || state.apiMessageId === apiMessageId)
      ) return state;
    }
    const uuid = boundedClaudeIdentifier(message.uuid);
    return uuid
      ? this.states.get(`sdk:${uuid}`) ?? this.states.get(uuid)
      : undefined;
  }

  appendDelta(
    state: ClaudeStreamState,
    index: number,
    kind: "text" | "thinking",
    value: string,
  ): void {
    const existing = state.blocks.get(index);
    const current = existing?.[kind] ?? "";
    const addsBlock = existing === undefined;
    if (
      current.length + value.length > MAX_CLAUDE_PROJECTOR_EVENT_TEXT_CHARS
      || (addsBlock
        && this.retainedBlocks >= MAX_CLAUDE_STREAM_CORRELATION_BLOCKS)
      || this.retainedChars + value.length
        > MAX_CLAUDE_STREAM_CORRELATION_CHARS
    ) {
      throw new Error(
        "Claude exceeded the bounded stream-correlation state for this run.",
      );
    }
    const block = existing ?? { text: "", thinking: "" };
    block[kind] = `${current}${value}`;
    state.blocks.set(index, block);
    if (addsBlock) this.retainedBlocks += 1;
    this.retainedChars += value.length;
  }

  resolveTextItemId(providerMessageId: string): string | undefined {
    const state = this.states.get(providerMessageId)
      ?? this.states.get(`sdk:${providerMessageId}`)
      ?? this.states.get(`api:${providerMessageId}`);
    return state?.textItemId;
  }

  remove(keyOrId: string): void {
    const direct = this.states.get(keyOrId);
    const state = direct
      ?? this.states.get(`sdk:${keyOrId}`)
      ?? this.states.get(`api:${keyOrId}`);
    if (!state) return;
    this.states.delete(state.key);
    for (const block of state.blocks.values()) {
      this.retainedBlocks -= 1;
      this.retainedChars -= block.text.length + block.thinking.length;
    }
    if (state.apiMessageId) this.keyByApiMessageId.delete(state.apiMessageId);
    if (
      state.sessionId
      && this.currentKeyBySession.get(state.sessionId) === state.key
    ) this.currentKeyBySession.delete(state.sessionId);
  }

  reset(): void {
    this.states.clear();
    this.retainedBlocks = 0;
    this.retainedChars = 0;
    this.keyByApiMessageId.clear();
    this.currentKeyBySession.clear();
  }
}
