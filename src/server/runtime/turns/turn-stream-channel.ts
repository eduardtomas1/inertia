import {
  TurnStreamCoalescer,
  type DeltaTimerScheduler,
  type StreamDeltaFlush,
} from "./turn-stream-coalescer";

export const STREAM_PROJECTION_FIRST_FLUSH_MS = 24;
export const STREAM_PROJECTION_FLUSH_INTERVAL_MS = 64;
export const STREAM_PROJECTION_CHAR_THRESHOLD = 16_384;

export interface TurnStreamChannelOptions {
  scheduler: DeltaTimerScheduler;
  onProjectionFlush(flush: StreamDeltaFlush): void;
  onPersistenceFlush(flush: StreamDeltaFlush): void;
  onTimerError(error: unknown): void;
  onFlushStarted?(): void;
}

/**
 * Gives live rendering and durable storage one bounded, ordered cadence.
 *
 * The 64ms sustained window keeps visible updates below a 100ms interaction
 * budget without persisting every provider callback. Each flush persists
 * before it projects, so text that reached a renderer also survives an abrupt
 * utility-process loss. Explicit lifecycle edges drain the same channel before
 * terminal snapshots.
 */
export class TurnStreamChannel {
  private readonly channel: TurnStreamCoalescer;

  constructor(options: TurnStreamChannelOptions) {
    this.channel = new TurnStreamCoalescer({
      scheduler: options.scheduler,
      firstFlushMs: STREAM_PROJECTION_FIRST_FLUSH_MS,
      flushIntervalMs: STREAM_PROJECTION_FLUSH_INTERVAL_MS,
      maxBufferedChars: STREAM_PROJECTION_CHAR_THRESHOLD,
      onFlush: (flush) => {
        options.onFlushStarted?.();
        // Never make text user-visible before the same ordered prefix is
        // durable. This keeps abrupt utility-process loss from rolling the
        // transcript behind what the renderer already showed.
        options.onPersistenceFlush(flush);
        options.onProjectionFlush(flush);
      },
      onTimerError: options.onTimerError,
    });
  }

  get hasPending(): boolean {
    return this.channel.hasPending;
  }

  append(delta: string): void {
    this.channel.append(delta);
  }

  replacePending(value: string): void {
    this.channel.replacePending(value);
  }

  flush(): boolean {
    return this.channel.flush();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
