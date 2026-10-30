import { durableId } from "./json";

/** Serial within a thread; independent threads may make progress concurrently. */
export class OrchestrationCommandLanes {
  private readonly lanes = new Map<string, { tail: Promise<void>; depth: number }>();
  private pending = 0;
  private closed = false;

  run<T>(threadId: string, command: () => T | Promise<T>): Promise<T> {
    durableId(threadId);
    if (this.closed) return Promise.reject(new Error("Orchestration is shutting down."));
    const previous = this.lanes.get(threadId);
    if (this.pending >= 4_096 || (previous?.depth ?? 0) >= 256) {
      return Promise.reject(new Error("The orchestration command queue is full."));
    }
    const lane = previous ?? { tail: Promise.resolve(), depth: 0 };
    lane.depth += 1;
    this.pending += 1;
    const result = lane.tail.then(command);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      lane.depth -= 1;
      this.pending -= 1;
      if (lane.tail === tail) this.lanes.delete(threadId);
    });
    lane.tail = tail;
    this.lanes.set(threadId, lane);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.lanes.values()].map(({ tail }) => tail));
  }
}
