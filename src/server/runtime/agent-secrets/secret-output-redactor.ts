import { BoundarySecretRedactor, SecretMatcher } from "../../provider/acp-redaction";
import {
  credentialEncodings,
  redactExactCredentials,
  stripTerminalControlSequences,
} from "../../provider/activity-detail";
import type {
  ProviderActivityEvent,
  ProviderEvent,
  ProviderReasoningEvent,
  ProviderRunResult,
  ProviderTextEvent,
} from "../../provider/contracts";

const MAX_DEPTH = 32;
const MAX_OUTPUT_STREAMS_PER_TURN = 64;

const ASSISTANT_SEGMENT_CLOSERS: ReadonlySet<ProviderEvent["type"]> = new Set([
  "text-boundary",
  "text-snapshot",
  "activity",
  "plan",
  "approval",
  "input",
]);

interface Stream<T extends ProviderEvent> {
  boundary: BoundarySecretRedactor;
  template: T;
}

interface TurnStreams {
  text: Stream<ProviderTextEvent> | null;
  reasoning: Stream<ProviderReasoningEvent> | null;
  outputs: Map<string, Stream<ProviderActivityEvent>>;
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

function withoutOutput(event: ProviderActivityEvent): ProviderActivityEvent {
  const { outputDelta: _outputDelta, ...rest } = event;
  return rest;
}

function withOutput(event: ProviderActivityEvent, output: string): ProviderActivityEvent {
  return output ? { ...event, outputDelta: output } : event;
}

function outputTemplate(event: ProviderActivityEvent): ProviderActivityEvent {
  const { outputDelta: _outputDelta, detail: _detail, fileMutation: _fileMutation, ...rest } = event;
  return { ...rest, phase: "started" };
}

export class SecretOutputRedactor {
  private sources: ReadonlySet<string> = new Set();
  private matcher = SecretMatcher.empty;
  private readonly turns = new Map<string, TurnStreams>();

  setValues(values: readonly string[]): void {
    const sources = new Set(values);
    if (sources.size === this.sources.size && [...sources].every((value) => this.sources.has(value))) return;
    this.sources = sources;
    this.matcher = new SecretMatcher(credentialEncodings([...sources]));
  }

  values(): readonly string[] {
    return this.matcher.secrets;
  }

  active(): boolean {
    return this.matcher.secrets.length > 0;
  }

  text(value: string): string {
    if (!this.active()) return value;
    const direct = redactExactCredentials(value, this.matcher.secrets);
    const stripped = stripTerminalControlSequences(direct);
    if (stripped === direct) return direct;
    const redacted = redactExactCredentials(stripped, this.matcher.secrets);
    return redacted === stripped ? direct : redacted;
  }

  payload<T>(value: T): T {
    if (!this.active()) return value;
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
    const turn = this.turns.get(event.turnId);
    if (!turn && !this.active()) return [event];
    if (event.type === "text") return this.streamText(event);
    if (event.type === "reasoning-summary") return this.streamReasoning(event);
    const closed = ASSISTANT_SEGMENT_CLOSERS.has(event.type) ? this.closeText(event.turnId) : [];
    if (event.type === "activity") return [...closed, ...this.activity(event)];
    return [...closed, this.payload(event)];
  }

  closeText(turnId: string): readonly ProviderEvent[] {
    const turn = this.turns.get(turnId);
    const stream = turn?.text;
    if (!turn || !stream) return [];
    turn.text = null;
    this.forgetEmptyTurn(turnId, turn);
    const text = stream.boundary.finish("significant");
    return text ? [{ ...stream.template, text }] : [];
  }

  result(result: ProviderRunResult): SecretOutputResult {
    const events = this.finishTurn(result.turnId);
    if (!this.active()) return { events, result };
    const { cleanupConfirmation, ...rest } = result;
    const redacted = this.payload(rest);
    const next = redacted === rest ? result : {
      ...redacted,
      ...(cleanupConfirmation ? { cleanupConfirmation } : {}),
    };
    return { events, result: next };
  }

  discard(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    turn.text?.boundary.discard();
    turn.reasoning?.boundary.discard();
    for (const output of turn.outputs.values()) output.boundary.discard();
  }

  private streamText(event: ProviderTextEvent): readonly ProviderEvent[] {
    const turn = this.turnStreams(event.turnId);
    const stream = turn.text ??= this.open(event);
    stream.template = event;
    const text = stream.boundary.push(event.text);
    return text ? [{ ...event, text }] : [];
  }

  private streamReasoning(event: ProviderReasoningEvent): readonly ProviderEvent[] {
    const turn = this.turnStreams(event.turnId);
    const stream = turn.reasoning ??= this.open(event);
    stream.template = event;
    const text = stream.boundary.push(event.text);
    return text ? [{ ...event, text }] : [];
  }

  private activity(event: ProviderActivityEvent): readonly ProviderEvent[] {
    const safe = this.payload(withoutOutput(event));
    const activityId = event.activityId;
    const turn = this.turns.get(event.turnId);
    const existing = activityId ? turn?.outputs.get(activityId) : undefined;
    if (!activityId || (!existing && !event.outputDelta)) {
      return [event.outputDelta ? withOutput(safe, this.text(event.outputDelta)) : safe];
    }
    const emitted: ProviderEvent[] = [];
    const streams = this.turnStreams(event.turnId).outputs;
    let stream = existing;
    if (!stream) {
      const evicted = streams.size >= MAX_OUTPUT_STREAMS_PER_TURN ? streams.keys().next().value : undefined;
      if (evicted !== undefined) emitted.push(...this.finishOutput(streams, evicted));
      stream = this.open(outputTemplate(safe));
      streams.set(activityId, stream);
    }
    let output = event.outputDelta
      ? stream.boundary.push(stripTerminalControlSequences(event.outputDelta))
      : "";
    if (event.phase !== "started" || event.detail !== undefined) {
      streams.delete(activityId);
      output += stream.boundary.finish("significant");
    } else {
      stream.template = outputTemplate(safe);
    }
    emitted.push(withOutput(safe, output));
    return emitted;
  }

  private finishTurn(turnId: string): ProviderEvent[] {
    const turn = this.turns.get(turnId);
    if (!turn) return [];
    const events: ProviderEvent[] = [...this.closeText(turnId)];
    this.turns.delete(turnId);
    for (const activityId of turn.outputs.keys()) events.push(...this.finishOutput(turn.outputs, activityId));
    const reasoning = turn.reasoning;
    const text = reasoning?.boundary.finish("significant");
    if (reasoning && text) events.push({ ...reasoning.template, text });
    return events;
  }

  private finishOutput(streams: Map<string, Stream<ProviderActivityEvent>>, activityId: string): ProviderEvent[] {
    const stream = streams.get(activityId);
    if (!stream) return [];
    streams.delete(activityId);
    const output = stream.boundary.finish("significant");
    return output ? [withOutput(stream.template, output)] : [];
  }

  private turnStreams(turnId: string): TurnStreams {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { text: null, reasoning: null, outputs: new Map() };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private forgetEmptyTurn(turnId: string, turn: TurnStreams): void {
    if (!turn.text && !turn.reasoning && turn.outputs.size === 0) this.turns.delete(turnId);
  }

  private open<T extends ProviderEvent>(template: T): Stream<T> {
    return { boundary: new BoundarySecretRedactor(() => this.matcher), template };
  }
}
