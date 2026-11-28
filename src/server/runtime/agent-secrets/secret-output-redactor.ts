import { BoundarySecretRedactor, SecretMatcher, SIGNIFICANT_SECRET_PREFIX_CHARS } from "../../provider/acp-redaction";
import {
  credentialEncodings,
  PROVIDER_ACTIVITY_DETAIL_OMISSION,
  stripTerminalControlSequences,
} from "../../provider/activity-detail";
import type {
  ProviderActivityEvent,
  ProviderEvent,
  ProviderReasoningEvent,
  ProviderRunResult,
  ProviderTextEvent,
  ProviderTextSnapshotEvent,
} from "../../provider/contracts";
import { StreamingTerminalControlStripper } from "./streaming-terminal-control-stripper";

const MAX_DEPTH = 32;
const OVER_DEPTH = "[redacted:over-depth]";
const STRUCTURAL_KEY = /^(?:id|type|kind|status|phase|decision)$|Id$/u;
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
  stripper: StreamingTerminalControlStripper;
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

function prefixOverlapWithTable(
  pattern: string,
  failure: Int32Array,
  text: string,
): number {
  let state = 0;
  for (let index = Math.max(0, text.length - pattern.length); index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    while (state > 0 && code !== pattern.charCodeAt(state)) state = failure[state - 1]!;
    if (code === pattern.charCodeAt(state)) state += 1;
    if (state === pattern.length) state = failure[state - 1]!;
  }
  return state;
}

function prefixOverlapReversedWithTable(
  reversePattern: string,
  reverseFailure: Int32Array,
  text: string,
): number {
  let state = 0;
  const limit = Math.min(text.length, reversePattern.length);
  for (let index = limit - 1; index >= 0; index -= 1) {
    const code = text.charCodeAt(index);
    while (state > 0 && code !== reversePattern.charCodeAt(state)) state = reverseFailure[state - 1]!;
    if (code === reversePattern.charCodeAt(state)) state += 1;
    if (state === reversePattern.length) state = reverseFailure[state - 1]!;
  }
  return state;
}

function significantOverlap(length: number, secretLength: number): boolean {
  return length >= SIGNIFICANT_SECRET_PREFIX_CHARS || length * 2 >= secretLength;
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
    return this.omissionEdges(this.exact(value));
  }

  private exact(value: string): string {
    const direct = this.matcher.redact(value);
    const stripped = stripTerminalControlSequences(direct);
    if (stripped === direct) return direct;
    const redacted = this.matcher.redact(stripped);
    return redacted === stripped ? direct : redacted;
  }

  private omissionEdges(value: string): string {
    if (!value.includes("… [") || !PROVIDER_ACTIVITY_DETAIL_OMISSION.test(value)) return value;
    const parts = value.split(PROVIDER_ACTIVITY_DETAIL_OMISSION);
    for (let index = 0; index < parts.length; index += 2) {
      let part = parts[index]!;
      if (index > 0) part = this.redactEdge(part, "start");
      if (index + 2 < parts.length) part = this.redactEdge(part, "end");
      parts[index] = part;
    }
    return parts.join("");
  }

  private redactEdge(part: string, edge: "start" | "end"): string {
    let longest = 0;
    for (const pattern of this.matcher.edgePatterns) {
      const length = edge === "end"
        ? prefixOverlapWithTable(pattern.forward, pattern.forwardFailure, part)
        : prefixOverlapReversedWithTable(pattern.reverse, pattern.reverseFailure, part);
      if (length > longest && significantOverlap(length, pattern.length)) longest = length;
    }
    if (longest === 0) return part;
    return edge === "end" ? `${part.slice(0, -longest)}[redacted]` : `[redacted]${part.slice(longest)}`;
  }

  payload<T>(value: T, structural = false): T {
    if (!this.active()) return value;
    const visit = (current: unknown, depth: number): unknown => {
      if (typeof current === "string") return this.text(current);
      if (Array.isArray(current)) {
        if (depth >= MAX_DEPTH) return OVER_DEPTH;
        let changed = false;
        const next = current.map((entry) => {
          const visited = visit(entry, depth + 1);
          if (visited !== entry) changed = true;
          return visited;
        });
        return changed ? next : current;
      }
      if (!plainObject(current)) return current;
      if (depth >= MAX_DEPTH) return OVER_DEPTH;
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        const isStructuralKey = structural && STRUCTURAL_KEY.test(key);
        const redactedKey = isStructuralKey ? key : this.text(key);
        const visited = isStructuralKey && typeof entry === "string" ? entry : visit(entry, depth + 1);
        if (redactedKey !== key || visited !== entry) changed = true;
        next[redactedKey] = visited;
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
    if (event.type === "text-snapshot" && event.scope === "segment") return this.replaceTextSegment(event);
    const closed = ASSISTANT_SEGMENT_CLOSERS.has(event.type) ? this.closeText(event.turnId) : [];
    if (event.type === "activity") return [...closed, ...this.activity(event)];
    return [...closed, this.payload(event, true)];
  }

  closeText(turnId: string): readonly ProviderEvent[] {
    const turn = this.turns.get(turnId);
    const stream = turn?.text;
    if (!turn || !stream) return [];
    turn.text = null;
    this.forgetEmptyTurn(turnId, turn);
    const text = this.finishStream(stream);
    return text ? [{ ...stream.template, text }] : [];
  }

  result(result: ProviderRunResult): SecretOutputResult {
    const events = this.finishTurn(result.turnId);
    if (!this.active()) return { events, result };
    const { cleanupConfirmation, ...rest } = result;
    const redacted = this.payload(rest, true);
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
    turn.text?.stripper.discard();
    turn.text?.boundary.discard();
    turn.reasoning?.stripper.discard();
    turn.reasoning?.boundary.discard();
    for (const output of turn.outputs.values()) {
      output.stripper.discard();
      output.boundary.discard();
    }
  }

  private streamText(event: ProviderTextEvent): readonly ProviderEvent[] {
    const turn = this.turnStreams(event.turnId);
    const stream = turn.text ??= this.open(event);
    stream.template = event;
    const cleaned = stream.stripper.push(event.text);
    const text = cleaned ? stream.boundary.push(cleaned) : "";
    return text ? [{ ...event, text }] : [];
  }

  /**
   * Like a reasoning replacement: the open segment's stream restarts with the snapshot, so a held-back secret
   * prefix of the abandoned text is dropped and the snapshot's own possible prefix is held for the next text.
   */
  private replaceTextSegment(event: ProviderTextSnapshotEvent): readonly ProviderEvent[] {
    const turn = this.turnStreams(event.turnId);
    turn.text?.boundary.discard();
    const { providerId, conversationId, runId, turnId } = event;
    const stream = turn.text = this.open<ProviderTextEvent>({ providerId, conversationId, runId, turnId, type: "text", text: "" });
    return [{ ...event, text: stream.boundary.push(event.text) }];
  }

  private streamReasoning(event: ProviderReasoningEvent): readonly ProviderEvent[] {
    const turn = this.turnStreams(event.turnId);
    const { replace, ...appended } = event;
    // A replacement abandons what the stream held back; it restarts the stream, and a held-back tail of its own
    // follows as an append. An empty replacement still clears what was shown.
    if (replace) {
      turn.reasoning?.stripper.discard();
      turn.reasoning?.boundary.discard();
    }
    const stream = replace ? turn.reasoning = this.open(appended) : turn.reasoning ??= this.open(appended);
    stream.template = appended;
    const cleaned = stream.stripper.push(event.text);
    const text = cleaned ? stream.boundary.push(cleaned) : "";
    return text || replace ? [{ ...event, text }] : [];
  }

  private activity(event: ProviderActivityEvent): readonly ProviderEvent[] {
    const safe = this.payload(withoutOutput(event), true);
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
    let output = "";
    if (event.outputDelta) {
      const cleaned = stream.stripper.push(event.outputDelta);
      if (cleaned) output = stream.boundary.push(this.omissionEdges(cleaned));
    }
    if (event.phase !== "started" || event.detail !== undefined) {
      streams.delete(activityId);
      output += this.finishStream(stream, true);
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
    const text = reasoning ? this.finishStream(reasoning) : "";
    if (reasoning && text) events.push({ ...reasoning.template, text });
    return events;
  }

  private finishOutput(streams: Map<string, Stream<ProviderActivityEvent>>, activityId: string): ProviderEvent[] {
    const stream = streams.get(activityId);
    if (!stream) return [];
    streams.delete(activityId);
    const output = this.finishStream(stream, true);
    return output ? [withOutput(stream.template, output)] : [];
  }

  private finishStream<T extends ProviderEvent>(stream: Stream<T>, applyOmissionEdges = false): string {
    const trailing = stream.stripper.finish();
    let output = "";
    if (trailing) {
      output += stream.boundary.push(applyOmissionEdges ? this.omissionEdges(trailing) : trailing);
    }
    output += stream.boundary.finish("significant");
    return output;
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
    return {
      boundary: new BoundarySecretRedactor(() => this.matcher),
      stripper: new StreamingTerminalControlStripper(),
      template,
    };
  }
}
