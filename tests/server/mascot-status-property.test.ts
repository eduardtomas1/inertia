import { describe, expect, it } from "vitest";
import type { AgentRunState } from "../../src/shared/run-state";
import { AGENT_RUN_STATES } from "../../src/shared/run-state";
import { mascotFeedViolation, parseMascotFeed } from "../../src/shared/mascot-feed";
import { mascotPublisher, mascotShell } from "../helpers/mascot-fixture";

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const ADVANCES = [100, 500, 1_400, 1_600, 60_000, 11 * 60_000, 61 * 60_000, 3 * 3_600_000, 23 * 3_600_000];
const WORDS = [
  "I am checking the files now.", "Running the tests next.", "Done with the edit.", "\ud83d", "Half an emoji \ude00 here.",
  `${"x".repeat(4_000)}. Short ${"y".repeat(85)}😀😀`, `${"z".repeat(95)}😀`, `${"w".repeat(4_095)}😀`,
];

function run(seed: number): string | null {
  const next = random(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const shells = new Map<string, ReturnType<typeof mascotShell>>();
  const { publisher, feed, clock, publish } = mascotPublisher({ lookup: (id) => shells.get(id) ?? null });
  const ids = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, index) => `c${index}`);
  const iso = (time: number): string => new Date(time).toISOString();
  let request = 0;
  for (let step = 0; step < 80; step += 1) {
    const action = next();
    const id = pick(ids);
    const now = clock.now();
    const shell = shells.get(id);
    const owner = shell?.latestTurn ? { conversationId: id, runId: shell.latestTurn.runId, turnId: shell.latestTurn.id } : null;
    if (action < 0.45) {
      const state: AgentRunState = pick(AGENT_RUN_STATES);
      const turnId = !shell || next() < 0.3 ? `${id}-t${step}` : shell.latestTurn!.id;
      const updated = mascotShell(id, state, {
        turnId, requestedAt: iso(now - Math.floor(next() * 1e6)), updatedAt: iso(now - Math.floor(next() * 1e5)),
        lastViewedAt: next() < 0.3 ? iso(now + 1_000) : null, title: pick(WORDS),
      });
      updated.latestTurn!.runId = `${turnId}-run`;
      shells.set(id, updated);
      publisher.update(updated);
    } else if (action < 0.55) {
      request += 1;
      publisher.focus(next() < 0.5 ? null : pick(ids), request);
    } else if (action < 0.65) {
      if (shell) { shells.delete(id); publisher.update({ ...shell, archivedAt: iso(now) }); }
    } else if (action < 0.78) {
      if (!owner) continue;
      const kind = Math.floor(next() * 7);
      if (kind === 0) publisher.observe({ type: "agent.input.requested", request: { ...owner, id: `q${step}`, providerId: "codex", autoResolutionMs: null,
        questions: [{ id: "x", header: "h", question: pick(WORDS), isSecret: false, isOther: false, allowMultiple: false, options: [] }] } });
      if (kind === 1) publisher.observe({ type: "agent.commentary.persisted", message: { id: `m${step}`, conversationId: id, turnId: owner.turnId,
        role: "assistant", attachments: [], content: pick(WORDS), createdAt: iso(now) } as never });
      if (kind === 2) publisher.observe({ type: "agent.activity", activity: { ...owner, id: `a${step}`, kind: "command", title: "Run command",
        detail: `Command:\n${pick(WORDS)}`, status: pick(["running", "completed", "failed"] as const), createdAt: iso(now) } });
      if (kind === 3) publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: null,
        steps: [{ step: "Read", status: "completed" }, { step: "Write code", status: pick(["inProgress", "pending"] as const) }] } });
      if (kind === 4) publisher.observe({ type: "agent.text", ...owner, text: "words" });
      if (kind === 5) publisher.observe({ type: "agent.input.resolved", ...owner, requestId: `q${step - 1}` });
      if (kind === 6) publisher.observe({ type: "agent.approval.requested", request: { ...owner, id: `p${step}`, providerId: "codex", kind: "command",
        title: "Run command", command: "rm -rf build", detail: null, reason: null, cwd: null, networkScope: null, permissionRoots: [], availableDecisions: ["approve", "deny"] } });
    } else if (action < 0.8) {
      const kept = [...shells.values()].filter(() => next() < 0.8);
      for (const key of shells.keys()) if (!kept.some((entry) => entry.id === key)) shells.delete(key);
      publisher.replace(kept);
    } else {
      clock.advance(pick(ADVANCES));
    }
    if (!publish.mock.calls.length) continue;
    const current = feed();
    const violation = mascotFeedViolation(current);
    if (violation) return `seed ${seed} step ${step}: ${violation}`;
    if (!parseMascotFeed(JSON.parse(JSON.stringify(current)) as Record<string, unknown>)) return `seed ${seed} step ${step}: unparsable`;
    if (clock.pending() > 1) return `seed ${seed} step ${step}: ${clock.pending()} wake timers`;
    const first = shells.values().next().value;
    if (first) {
      const before = JSON.stringify(current);
      publisher.update(first);
      if (JSON.stringify(feed()) !== before) return `seed ${seed} step ${step}: a due change waited for an unrelated update`;
    }
  }
  return null;
}

describe("mascot feed under random sequences", () => {
  it("keeps the feed valid when a waiting chat's bubble expires with nothing else to show", () => {
    expect(run(7)).toBeNull();
  });

  it("keeps every invariant, one wake timer and no missed deadline across 500 sequences", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 500 && failures.length < 5; seed += 1) {
      const failure = run(seed);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });
});
