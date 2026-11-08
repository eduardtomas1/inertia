import { StringDecoder } from "node:string_decoder";
import {
  RUNTIME_CHROMIUM_LOG_LEVELS,
  RUNTIME_NODE_WARNING_NAMES,
  type RuntimeChromiumLogLevel,
  type RuntimeNodeWarningName,
  type RuntimeStderrCode,
} from "./runtime-diagnostic-events.js";

const CLASSIFIERS: ReadonlyArray<readonly [string, Exclude<RuntimeStderrCode, "omitted">]> = [
  ["The scheduled database backup failed.", "database-backup-failed"],
  ["Database migration failed and rolled back", "database-migration-failed"],
  ["Unable to record system suspend accounting.", "suspend-accounting-failed"],
  ["A runtime settlement snapshot could not be published.", "settlement-snapshot-unpublished"],
  ["A turn update could not be published.", "turn-update-unpublished"],
  ["Turn post-processing diagnostic could not be persisted.", "turn-diagnostic-unpersisted"],
  ["A malformed persisted review summary was omitted from the runtime snapshot.", "review-summary-malformed"],
  ["Git scan cleanup failed after the scan timed out.", "git-scan-cleanup-failed"],
  ["Terminal provider resume rejected.", "terminal-resume-rejected"],
];

const SDK_WARNING_PREFIXES = [
  "SDK debug logs: ",
  "Tool name validation warning for \"",
  "Tool registration will proceed, but this may cause compatibility issues.",
  "Consider updating the tool name to conform to the MCP tool naming",
  "See SEP: Specify Format for Tool Names",
  "Warning: OpenAI may not support ",
  "Could not convert regex pattern at ",
  "Recursive reference detected at ",
];
const NODE_WARNING = /^\([A-Za-z][\w .-]{0,40}:\d+\) (?:\[[A-Z0-9_]+\] )?([A-Za-z]*Warning)(?=[:\s]|$)/u;
const NODE_WARNING_HINT = /^\(Use `[^`]*` to show where the warning was created\)$/u;
const TRACE_FLAG = /--trace-[a-z-]/u;
const STACK_FRAME = /^at \S/u;
const CHROMIUM_LOG = /^\[(?:\d+:){0,2}\d{4}\/\d{6}(?:\.\d+)?:([A-Z]+)\d*:[^\]]*\]/u;

type RuntimeStderrShapeCode =
  | "node-warning-hint" | "stack-frame" | "sdk-warning" | "json" | "other"
  | `node-warning:${RuntimeNodeWarningName}`
  | `chromium-log:${RuntimeChromiumLogLevel}`;

export function classifyRuntimeStderrLine(line: string): Exclude<RuntimeStderrCode, "omitted"> | null {
  return CLASSIFIERS.find(([prefix]) => line.startsWith(prefix))?.[1] ?? null;
}

function closedMember<T extends string>(values: readonly T[], value: string | undefined, fallback: T): T {
  return value !== undefined && (values as readonly string[]).includes(value) ? value as T : fallback;
}

function jsonLine(line: string): boolean {
  if (!/^[[{]/u.test(line)) return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

export function classifyRuntimeStderrShape(line: string): RuntimeStderrShapeCode {
  const warning = NODE_WARNING.exec(line);
  if (warning) {
    return `node-warning:${closedMember<RuntimeNodeWarningName>(RUNTIME_NODE_WARNING_NAMES, warning[1], "other")}`;
  }
  if (NODE_WARNING_HINT.test(line) && TRACE_FLAG.test(line)) return "node-warning-hint";
  if (STACK_FRAME.test(line)) return "stack-frame";
  const chromium = CHROMIUM_LOG.exec(line);
  if (chromium) {
    return `chromium-log:${closedMember<RuntimeChromiumLogLevel>(RUNTIME_CHROMIUM_LOG_LEVELS, chromium[1], "other")}`;
  }
  if (SDK_WARNING_PREFIXES.some((prefix) => line.startsWith(prefix))) return "sdk-warning";
  if (jsonLine(line)) return "json";
  return "other";
}

interface Timer {
  unref?: () => unknown;
}

interface AdmissionWindow {
  startedAt: number;
  records: number;
}

export interface RuntimeStderrJournalOptions {
  record: (code: RuntimeStderrCode, count: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  maxLineLength?: number;
  maxRecordsPerWindow?: number;
  windowMs?: number;
  omittedDelayMs?: number;
}

export class RuntimeStderrJournal {
  private readonly decoder = new StringDecoder("utf8");
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RuntimeStderrJournalOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<RuntimeStderrJournalOptions["clearTimer"]>;
  private readonly maxLineLength: number;
  private readonly maxRecordsPerWindow: number;
  private readonly windowMs: number;
  private readonly omittedDelayMs: number;
  private pending = "";
  private overflowing = false;
  private readonly deferred = new Map<RuntimeStderrCode, number>();
  private readonly lineWindow: AdmissionWindow = { startedAt: Number.NEGATIVE_INFINITY, records: 0 };
  private readonly summaryWindow: AdmissionWindow = { startedAt: Number.NEGATIVE_INFINITY, records: 0 };
  private timer: Timer | null = null;
  private ended = false;

  constructor(private readonly options: RuntimeStderrJournalOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.maxLineLength = options.maxLineLength ?? 4_096;
    this.maxRecordsPerWindow = options.maxRecordsPerWindow ?? 20;
    this.windowMs = options.windowMs ?? 60_000;
    this.omittedDelayMs = options.omittedDelayMs ?? 5_000;
  }

  bufferedLength(): number {
    return this.pending.length;
  }

  write(chunk: Buffer | string): void {
    if (this.ended) return;
    let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = text.indexOf("\n");
    while (newline >= 0) {
      this.append(text.slice(0, newline));
      this.completeLine();
      text = text.slice(newline + 1);
      newline = text.indexOf("\n");
    }
    this.append(text);
  }

  end(): void {
    if (this.ended) return;
    this.append(this.decoder.end());
    if (this.pending || this.overflowing) this.completeLine();
    this.ended = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    for (const [code, count] of this.deferred) this.options.record(code, Math.min(count, 1_000_000));
    this.deferred.clear();
  }

  private append(text: string): void {
    if (this.overflowing || !text) return;
    if (this.pending.length + text.length > this.maxLineLength) {
      this.pending = "";
      this.overflowing = true;
      return;
    }
    this.pending += text;
  }

  private completeLine(): void {
    const line = this.pending.replace(/\r$/u, "").trim();
    const overflowed = this.overflowing;
    this.pending = "";
    this.overflowing = false;
    if (!line && !overflowed) return;
    const code = overflowed ? null : classifyRuntimeStderrLine(line);
    if (code && this.admit(this.lineWindow)) {
      this.options.record(code, 1);
      return;
    }
    this.defer(overflowed || code ? "omitted" : classifyRuntimeStderrShape(line));
  }

  private defer(code: RuntimeStderrCode): void {
    this.deferred.set(code, (this.deferred.get(code) ?? 0) + 1);
    this.schedule(this.omittedDelayMs);
  }

  private admit(window: AdmissionWindow): boolean {
    const now = this.now();
    if (now - window.startedAt >= this.windowMs) {
      window.startedAt = now;
      window.records = 0;
    }
    if (window.records >= this.maxRecordsPerWindow) return false;
    window.records += 1;
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.ended) return;
    this.timer = this.setTimer(() => this.flushDeferred(), delayMs);
    this.timer.unref?.();
  }

  private flushDeferred(): void {
    this.timer = null;
    if (this.deferred.size === 0) return;
    if (!this.admit(this.summaryWindow)) {
      this.schedule(Math.max(1, this.summaryWindow.startedAt + this.windowMs - this.now()));
      return;
    }
    for (const [code, count] of this.deferred) this.options.record(code, Math.min(count, 1_000_000));
    this.deferred.clear();
  }
}

export function attachRuntimeStderr(stream: NodeJS.ReadableStream | null, journal: RuntimeStderrJournal): void {
  if (!stream) return;
  stream.on("data", (chunk: Buffer | string) => journal.write(chunk));
  stream.on("end", () => journal.end());
  stream.on("close", () => journal.end());
  stream.on("error", () => journal.end());
}
