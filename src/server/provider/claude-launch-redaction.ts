import type {
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  LaunchSecretMatcher,
  LaunchSecretStream,
  launchSecretForms,
} from "./launch-secret-matcher";

export const CLAUDE_KEYED_LAUNCH_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

type StreamDeltaField = "text" | "thinking";

interface OpenStream {
  readonly redactor: LaunchSecretStream;
  readonly template: SDKPartialAssistantMessage;
  readonly field: StreamDeltaField;
  readonly parent: string;
  readonly index: number;
}

export function claudeKeyedLaunchSecrets(environment: NodeJS.ProcessEnv): string[] {
  const values = CLAUDE_KEYED_LAUNCH_ENVIRONMENT_KEYS
    .map((key) => environment[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return launchSecretForms(values);
}

export class ClaudeLaunchRedactor {
  private readonly streams = new Map<string, OpenStream>();
  private readonly matcher: LaunchSecretMatcher;

  constructor(secrets: readonly string[]) {
    this.matcher = new LaunchSecretMatcher(secrets);
  }

  static forEnvironment(environment: NodeJS.ProcessEnv): ClaudeLaunchRedactor | null {
    const secrets = claudeKeyedLaunchSecrets(environment);
    return secrets.length === 0 ? null : new ClaudeLaunchRedactor(secrets);
  }

  text(value: string): string {
    return this.matcher.mask(value);
  }

  payload<T>(value: T): T {
    return this.matcher.payload(value);
  }

  messages(message: SDKMessage): SDKMessage[] {
    if (message.type !== "stream_event") {
      return [...this.flush(() => true), this.payload(message)];
    }
    const parent = message.parent_tool_use_id ?? "";
    const event = message.event;
    if (event.type === "content_block_delta") {
      const field = event.delta.type === "text_delta"
        ? "text"
        : event.delta.type === "thinking_delta" ? "thinking" : null;
      if (field) return [this.streamDelta(message, parent, event.index, field)];
    }
    const flushed = event.type === "content_block_stop"
      ? this.flush((stream) => stream.parent === parent && stream.index === event.index)
      : event.type === "message_start" || event.type === "message_stop"
        ? this.flush((stream) => stream.parent === parent)
        : [];
    return [...flushed, this.payload(message)];
  }

  finish(): SDKMessage[] {
    return this.flush(() => true);
  }

  iterator(source: AsyncIterator<SDKMessage>): AsyncIterator<SDKMessage> {
    const queue: SDKMessage[] = [];
    let exhausted = false;
    return {
      next: async () => {
        while (queue.length === 0) {
          if (exhausted) return { done: true, value: undefined };
          const next = await source.next();
          if (next.done) {
            exhausted = true;
            queue.push(...this.finish());
          } else {
            queue.push(...this.messages(next.value));
          }
        }
        return { done: false, value: queue.shift()! };
      },
      return: async (value?: unknown) => {
        queue.length = 0;
        exhausted = true;
        this.streams.clear();
        return source.return ? await source.return(value) : { done: true, value: undefined };
      },
    };
  }

  private streamDelta(
    message: SDKPartialAssistantMessage,
    parent: string,
    index: number,
    field: StreamDeltaField,
  ): SDKMessage {
    const event = message.event as Extract<SDKPartialAssistantMessage["event"], { type: "content_block_delta" }>;
    const delta = event.delta as unknown as Record<StreamDeltaField, string>;
    const template = this.payload({
      ...message,
      event: { ...event, delta: { ...event.delta, [field]: "" } },
    } as SDKPartialAssistantMessage);
    const key = `${parent}\u0000${index}\u0000${field}`;
    let stream = this.streams.get(key);
    if (!stream) {
      stream = {
        redactor: new LaunchSecretStream(this.matcher),
        template,
        field,
        parent,
        index,
      };
      this.streams.set(key, stream);
    }
    return withDeltaText(template, field, stream.redactor.push(delta[field]));
  }

  private flush(matches: (stream: OpenStream) => boolean): SDKMessage[] {
    const flushed: SDKMessage[] = [];
    for (const [key, stream] of this.streams) {
      if (!matches(stream)) continue;
      this.streams.delete(key);
      const remainder = stream.redactor.finish();
      if (remainder) flushed.push(withDeltaText(stream.template, stream.field, remainder));
    }
    return flushed;
  }
}

function withDeltaText(
  template: SDKPartialAssistantMessage,
  field: StreamDeltaField,
  value: string,
): SDKMessage {
  const event = template.event as Extract<SDKPartialAssistantMessage["event"], { type: "content_block_delta" }>;
  return {
    ...template,
    event: { ...event, delta: { ...event.delta, [field]: value } },
  } as SDKPartialAssistantMessage;
}
