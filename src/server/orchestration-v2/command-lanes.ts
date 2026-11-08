import { AsyncLocalStorage } from "node:async_hooks";

import { durableId } from "./json";

export class OrchestrationLaneReentry extends Error {
  constructor(readonly threadId: string) {
    super("An orchestration command lane was entered again from its own section.");
    this.name = "OrchestrationLaneReentry";
  }
}

/** Serial within a thread; independent threads may make progress concurrently. */
export class OrchestrationCommandLanes {
  private readonly lanes = new Map<string, { tail: Promise<void>; depth: number }>();
  private readonly held = new AsyncLocalStorage<Set<string>>();
  private pending = 0;
  private closed = false;

  holds(threadId: string): boolean {
    return this.held.getStore()?.has(threadId) === true;
  }

  run<T>(threadId: string, command: () => T | Promise<T>): Promise<T> {
    durableId(threadId);
    if (this.closed) return Promise.reject(new Error("Orchestration is shutting down."));
    if (this.holds(threadId)) return Promise.reject(new OrchestrationLaneReentry(threadId));
    const previous = this.lanes.get(threadId);
    if (this.pending >= 4_096 || (previous?.depth ?? 0) >= 256) {
      return Promise.reject(new Error("The orchestration command queue is full."));
    }
    const lane = previous ?? { tail: Promise.resolve(), depth: 0 };
    lane.depth += 1;
    this.pending += 1;
    const result = lane.tail.then(() => this.section(threadId, command));
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

  private section<T>(threadId: string, command: () => T | Promise<T>): T | Promise<T> {
    const held = new Set(this.held.getStore() ?? []);
    held.add(threadId);
    let value: T | Promise<T>;
    try {
      value = this.held.run(held, command);
    } catch (error) {
      held.delete(threadId);
      throw error;
    }
    if (!(value instanceof Promise)) {
      held.delete(threadId);
      return value;
    }
    return value.finally(() => { held.delete(threadId); });
  }
}
