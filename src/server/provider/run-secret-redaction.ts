import { MIN_INITIATIVE_MCP_SECRET_CHARS } from "../../shared/initiative-mcp";
import { BoundarySecretRedactor } from "./acp-redaction";
import type {
  ProviderEvent,
  ProviderReasoningEvent,
  ProviderRunResult,
  ProviderTextEvent,
} from "./contracts";

/**
 * Replaces a run secret. It is exactly as long as the shortest secret the run
 * accepts, so replacing a whole secret never makes text longer and every
 * output limit a harness applied still holds after redaction.
 */
export const RUN_SECRET_MARKER = "[secret]";

/** Events at which open assistant text and reasoning are released. */
const STREAM_BOUNDARIES: ReadonlySet<ProviderEvent["type"]> = new Set([
  "text-boundary",
  "text-snapshot",
  "activity",
  "plan",
  "approval",
  "input",
]);

/**
 * Exact-value redaction of the secrets a run was given (initiative MCP header
 * and environment values), applied once, by the run coordinator, to every
 * event, the terminal result and failures.
 *
 * Only text-bearing fields are rewritten: message text, labels, details,
 * commands, questions and the like. Object keys, identities (conversation,
 * run, turn, session, request, item and tool-call ids), enumerations and
 * paths are never touched, so redaction cannot break event routing.
 *
 * Assistant text and reasoning arrive as deltas, and a secret can be split
 * across them. Each stream goes through a buffered redactor that holds back
 * text which could still be the start of a secret until the next delta
 * decides it. Held text is released at a text boundary (a boundary or
 * snapshot, an activity, a plan, an approval or a question) and when the run
 * ends; a held fragment that is a significant part of a secret is replaced
 * rather than released.
 *
 * Redaction matches exact values only. A provider that transforms a secret
 * (encodes it, for example) or repeats only part of it is not caught.
 */
export class RunSecretRedactor {
  private readonly secrets: readonly string[];
  private readonly assistant: BoundarySecretRedactor;
  private readonly reasoning: BoundarySecretRedactor;
  private lastText: ProviderTextEvent | null = null;
  private lastReasoning: ProviderReasoningEvent | null = null;

  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter((secret) => secret.length >= MIN_INITIATIVE_MCP_SECRET_CHARS))]
      .sort((left, right) => right.length - left.length);
    this.assistant = new BoundarySecretRedactor(() => this.secrets, RUN_SECRET_MARKER);
    this.reasoning = new BoundarySecretRedactor(() => this.secrets, RUN_SECRET_MARKER);
  }

  get active(): boolean {
    return this.secrets.length > 0;
  }

  /** Whole-value redaction of one string; never longer than its input. */
  text(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      if (result.includes(secret)) result = result.replaceAll(secret, RUN_SECRET_MARKER);
    }
    return result;
  }

  /** The events to deliver for one provider event, in order. */
  event(event: ProviderEvent): ProviderEvent[] {
    if (!this.active) return [event];
    switch (event.type) {
      case "text": {
        // A new item starts a new message: what the previous one held is released first.
        const released = this.lastText && this.lastText.itemId !== event.itemId ? this.releaseText() : [];
        this.lastText = event;
        const text = this.assistant.push(event.text);
        return text ? [...released, { ...event, text }] : released;
      }
      case "reasoning-summary": {
        this.lastReasoning = event;
        const text = this.reasoning.push(event.text);
        return text ? [{ ...event, text }] : [];
      }
      default:
        return STREAM_BOUNDARIES.has(event.type)
          ? [...this.flush(), this.fields(event)]
          : [this.fields(event)];
    }
  }

  /** Releases whatever the text and reasoning streams hold; used at the run's end. */
  flush(): ProviderEvent[] {
    return [...this.releaseText(), ...this.releaseReasoning()];
  }

  result(result: ProviderRunResult): ProviderRunResult {
    if (!this.active) return result;
    const failure = result.failure
      ? {
          ...result.failure,
          message: this.text(result.failure.message),
          ...(result.failure.technicalDetail !== undefined
            ? { technicalDetail: this.text(result.failure.technicalDetail) }
            : {}),
        }
      : undefined;
    return {
      ...result,
      text: this.text(result.text),
      ...(result.error !== undefined ? { error: this.text(result.error) } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  /** Redacts an error's message and stack in place. */
  error(error: unknown): void {
    if (!this.active || !(error instanceof Error)) return;
    error.message = this.text(error.message);
    if (typeof error.stack === "string") error.stack = this.text(error.stack);
  }

  private releaseText(): ProviderEvent[] {
    const last = this.lastText;
    if (!last || !this.assistant.holding()) return [];
    const text = this.assistant.flush("significant");
    return text ? [{ ...last, text }] : [];
  }

  private releaseReasoning(): ProviderEvent[] {
    const last = this.lastReasoning;
    if (!last || !this.reasoning.holding()) return [];
    const text = this.reasoning.flush("significant");
    return text ? [{ ...last, text }] : [];
  }

  private optional(value: string | undefined): string | undefined {
    return value === undefined ? undefined : this.text(value);
  }

  private fields(event: ProviderEvent): ProviderEvent {
    switch (event.type) {
      case "text-snapshot":
        return { ...event, text: this.text(event.text) };
      case "activity":
        return {
          ...event,
          label: this.text(event.label),
          ...(event.detail !== undefined ? { detail: this.text(event.detail) } : {}),
          ...(event.outputDelta !== undefined ? { outputDelta: this.text(event.outputDelta) } : {}),
        };
      case "status":
        return {
          ...event,
          ...(event.message !== undefined ? { message: this.text(event.message) } : {}),
          ...(event.providerState !== undefined ? { providerState: this.text(event.providerState) } : {}),
        };
      case "session-title":
        return { ...event, title: this.text(event.title) };
      case "approval": {
        const { request } = event;
        const detail = this.optional(request.detail);
        const command = this.optional(request.command);
        const reason = this.optional(request.reason);
        return {
          ...event,
          request: {
            ...request,
            title: this.text(request.title),
            ...(detail !== undefined ? { detail } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(reason !== undefined ? { reason } : {}),
          },
        };
      }
      case "input":
        return {
          ...event,
          request: {
            ...event.request,
            questions: event.request.questions.map((question) => ({
              ...question,
              header: this.text(question.header),
              question: this.text(question.question),
              options: question.options.map((option) => ({
                ...option,
                label: this.text(option.label),
                description: this.text(option.description),
              })),
            })),
          },
        };
      case "plan":
        return {
          ...event,
          explanation: event.explanation === null ? null : this.text(event.explanation),
          steps: event.steps.map((step) => ({ ...step, step: this.text(step.step) })),
        };
      case "goal-updated":
        return { ...event, goal: { ...event.goal, objective: this.text(event.goal.objective) } };
      case "subagent": {
        const text = (value: string | null): string | null => value === null ? null : this.text(value);
        return {
          ...event,
          providerRole: text(event.providerRole),
          providerName: text(event.providerName),
          description: text(event.description),
          progress: text(event.progress),
          result: text(event.result),
          ...(event.activity !== undefined ? { activity: this.text(event.activity) } : {}),
        };
      }
      // Identities, usage, metadata and enumerations carry no provider prose.
      default:
        return event;
    }
  }
}
