import { BoundarySecretRedactor } from "../../provider/acp-redaction";
import {
  credentialEncodings,
  redactExactCredentials,
  stripTerminalControlSequences,
} from "../../provider/activity-detail";
import type { ProviderEvent, ProviderRunResult, ProviderTextEvent } from "../../provider/contracts";

const MAX_DEPTH = 32;

interface TextStream {
  boundary: BoundarySecretRedactor;
  template: ProviderTextEvent;
}

export interface SecretOutputResult {
  events: readonly ProviderEvent[];
  result: ProviderRunResult;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export class SecretOutputRedactor {
  private encodings: string[] = [];
  private readonly streams = new Map<string, TextStream>();

  setValues(values: readonly string[]): void {
    this.encodings = credentialEncodings([...new Set(values)]);
    for (const stream of this.streams.values()) stream.boundary.invalidate();
  }

  values(): readonly string[] {
    return this.encodings;
  }

  active(): boolean {
    return this.encodings.length > 0;
  }

  text(value: string): string {
    if (this.encodings.length === 0) return value;
    const direct = redactExactCredentials(value, this.encodings);
    const stripped = stripTerminalControlSequences(direct);
    if (stripped === direct) return direct;
    const redacted = redactExactCredentials(stripped, this.encodings);
    return redacted === stripped ? direct : redacted;
  }

  payload<T>(value: T): T {
    if (this.encodings.length === 0) return value;
    const visit = (current: unknown, depth: number): unknown => {
      if (typeof current === "string") return this.text(current);
      if (Array.isArray(current)) {
        if (depth >= MAX_DEPTH) return current;
        let changed = false;
        const next = current.map((entry) => {
          const visited = visit(entry, depth + 1);
          if (visited !== entry) changed = true;
          return visited;
        });
        return changed ? next : current;
      }
      if (!plainObject(current) || depth >= MAX_DEPTH) return current;
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        const visited = visit(entry, depth + 1);
        if (visited !== entry) changed = true;
        next[key] = visited;
      }
      return changed ? next : current;
    };
    return visit(value, 0) as T;
  }

  events(event: ProviderEvent): readonly ProviderEvent[] {
    const stream = this.streams.get(event.turnId);
    if (event.type === "text") {
      if (!stream && this.encodings.length === 0) return [event];
      const current = stream ?? this.openStream(event);
      current.template = event;
      const text = current.boundary.push(event.text);
      return text ? [{ ...event, text }] : [];
    }
    const flushed = this.flush(event.turnId);
    const redacted = this.payload(event);
    return flushed ? [flushed, redacted] : [redacted];
  }

  result(result: ProviderRunResult): SecretOutputResult {
    const flushed = this.flush(result.turnId);
    if (this.encodings.length === 0) return { events: flushed ? [flushed] : [], result };
    const { cleanupConfirmation, ...rest } = result;
    const redacted = this.payload(rest);
    const next = redacted === rest ? result : {
      ...redacted,
      ...(cleanupConfirmation ? { cleanupConfirmation } : {}),
    };
    return { events: flushed ? [flushed] : [], result: next };
  }

  discard(turnId: string): void {
    this.streams.get(turnId)?.boundary.discard();
    this.streams.delete(turnId);
  }

  private openStream(event: ProviderTextEvent): TextStream {
    const stream: TextStream = {
      boundary: new BoundarySecretRedactor(() => this.encodings),
      template: event,
    };
    this.streams.set(event.turnId, stream);
    return stream;
  }

  private flush(turnId: string): ProviderTextEvent | null {
    const stream = this.streams.get(turnId);
    if (!stream) return null;
    this.streams.delete(turnId);
    const text = stream.boundary.finish("significant");
    return text ? { ...stream.template, text } : null;
  }
}
