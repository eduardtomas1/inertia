import { vi } from "vitest";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import { MascotStatusPublisher, type MascotClock } from "../../src/server/runtime/mascot-status";
import type { MascotFeed } from "../../src/shared/mascot-feed";

export const MASCOT_FIXTURE_NOW = Date.parse("2026-09-06T10:30:00.000Z");
const TERMINAL: readonly AgentRunState[] = ["completed", "failed", "cancelled", "interrupted"];

export interface MascotTestClock extends MascotClock {
  advance(milliseconds: number): void;
  pending(): number;
}

export function mascotTestClock(start = MASCOT_FIXTURE_NOW): MascotTestClock {
  let now = start;
  const timers = new Set<{ at: number; task: () => void }>();
  return {
    now: () => now,
    wake(delay, task) {
      const timer = { at: now + delay, task };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers].filter(({ at }) => at <= end).sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.task();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

export function mascotShell(id: string, state: AgentRunState, extra: Partial<ConversationShell> & {
  requestedAt?: string; updatedAt?: string; completedAt?: string | null; turnId?: string;
} = {}): ConversationShell {
  const { requestedAt = "2026-09-06T09:00:00.000Z", updatedAt = "2026-09-06T10:00:00.000Z", completedAt, turnId, ...rest } = extra;
  return {
    id, projectId: "project", title: `Chat ${id}`, status: "idle", archivedAt: null, lastViewedAt: null,
    latestTurn: {
      id: turnId ?? `${id}-turn`, runId: `${id}-run`, status: agentTurnStatusForRunState(state),
      runState: { state, revision: 1, providerState: "PRIVATE PROVIDER TEXT" },
      completedAt: completedAt === undefined ? TERMINAL.includes(state) ? updatedAt : null : completedAt,
      requestedAt, updatedAt,
    },
    ...rest,
  } as ConversationShell;
}

export function mascotPublisher(options: {
  lookup?: (id: string) => ConversationShell | null;
  projectName?: (id: string) => string | null;
  clock?: MascotTestClock;
} = {}) {
  const publish = vi.fn<(feed: MascotFeed) => void>();
  const clock = options.clock ?? mascotTestClock();
  const publisher = new MascotStatusPublisher(publish, options.lookup, options.projectName, (task) => task(), clock);
  const feed = (): MascotFeed => publish.mock.lastCall![0];
  return { publish, publisher, clock, feed };
}
