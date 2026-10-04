import { StringDecoder } from "node:string_decoder";
import type { RuntimeStderrCode } from "./runtime-diagnostic-events.js";

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

export function classifyRuntimeStderrLine(line: string): Exclude<RuntimeStderrCode, "omitted"> | null {
  return CLASSIFIERS.find(([prefix]) => line.startsWith(prefix))?.[1] ?? null;
}

interface Timer {
  unref?: () => unknown;
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
  private omitted = 0;
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private recordsInWindow = 0;
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
    if (this.omitted > 0) {
      this.options.record("omitted", Math.min(this.omitted, 1_000_000));
      this.omitted = 0;
    }
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
    if (code && this.admit()) {
      this.options.record(code, 1);
      return;
    }
    this.omitted += 1;
    this.schedule(this.omittedDelayMs);
  }

  private admit(): boolean {
    const now = this.now();
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.recordsInWindow = 0;
    }
    if (this.recordsInWindow >= this.maxRecordsPerWindow) return false;
    this.recordsInWindow += 1;
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.ended) return;
    this.timer = this.setTimer(() => this.flushOmitted(), delayMs);
    this.timer.unref?.();
  }

  private flushOmitted(): void {
    this.timer = null;
    if (this.omitted === 0) return;
    if (!this.admit()) {
      this.schedule(Math.max(1, this.windowStartedAt + this.windowMs - this.now()));
      return;
    }
    this.options.record("omitted", Math.min(this.omitted, 1_000_000));
    this.omitted = 0;
  }
}

export function attachRuntimeStderr(stream: NodeJS.ReadableStream | null, journal: RuntimeStderrJournal): void {
  if (!stream) return;
  stream.on("data", (chunk: Buffer | string) => journal.write(chunk));
  stream.on("end", () => journal.end());
  stream.on("close", () => journal.end());
  stream.on("error", () => journal.end());
}
