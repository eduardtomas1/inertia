// @inertia-test-suite portable
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import { runtimeInterruptionInstruction } from "../../src/server/runtime/turns/turn-runtime-interruption-note";
import { FakeTurnProvider } from "../support/fake-turn-provider";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  emitTurnControllerTestSubagent,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const notice = "Inertia stopped while your previous turn was running";

describe("runtime interruption note", () => {
  it("bounds the note to ten entries of at most 160 characters", () => {
    const { label, text } = runtimeInterruptionInstruction({
      request: `Refactor\n\nthe   parser ${"x".repeat(400)}`,
      lostTasks: Array.from({ length: 10 }, (_, index) => `Task ${index} ${"é".repeat(400)}`),
      lostTaskCount: 25,
    });
    const lines = text.split("\n");
    const entries = lines.filter((line) => line.startsWith("- ") && !line.startsWith("- and "));
    expect(label).toBe("runtime-interruption");
    expect(lines[1]).toMatch(/^Interrupted request: Refactor the parser x+…$/u);
    expect(Array.from(lines[1]!.slice("Interrupted request: ".length))).toHaveLength(160);
    expect(entries.length).toBeLessThanOrEqual(10);
    for (const entry of entries) expect(Array.from(entry.slice(2)).length).toBeLessThanOrEqual(160);
    expect(lines.at(-1)).toBe(`- and ${25 - entries.length} more`);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4 * 1024);
  });

  it.each(["unclean", "clean"] as const)("tells the first turn after a %s runtime stop about the interrupted turn and its lost tasks, once", async (close) => {
    const runtime = await createTurnControllerTestRuntime();
    const first = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Refactor the parser." });
    let generation: string | undefined;
    try {
      runtime.controller.start(first.turn.id);
      emitTurnControllerTestSubagent(runtime, {
        sequence: 1, providerTaskId: "task-1", status: "running", isLive: true,
        description: "Audit the tokenizer edge cases",
      });
      await flushTurnControllerTestPromises();
      if (close === "clean") await runtime.controller.dispose();
      generation = runtime.store.providerRunOwnership.all()[0]?.runtimeGenerationId;
    } finally {
      runtime.store.close();
    }
    const reopened = new RuntimeStore(join(runtime.directory, "inertia.sqlite"), runtime.workspace, { recoverInterruptedRuns: false });
    const provider = new FakeTurnProvider();
    let clockMs = Date.parse("2030-01-02T00:00:00.000Z");
    const next = new TurnController(reopened, provider, new Map(), new Map(), new Map(), {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [turnControllerTestProviderInfo()],
    }, { clock: () => new Date(clockMs++) });
    try {
      if (generation) reopened.providerRunOwnership.clearRuntimeGeneration(generation);
      reopened.recoverInterruptedRuns();
      expect(reopened.agentTurn(first.turn.id).status).toBe("interrupted");

      const second = next.queue({ conversationId: runtime.conversationId, content: "Continue." });
      next.start(second.turn.id);
      expect(provider.input?.prompt).toContain(notice);
      expect(provider.input?.prompt).toContain("Interrupted request: Refactor the parser.");
      expect(provider.input?.prompt).toContain("- Audit the tokenizer edge cases");
      provider.resolve({ status: "completed" });
      await flushTurnControllerTestPromises();
      await next.drainSettlementTasks();

      const third = next.queue({ conversationId: runtime.conversationId, content: "And the tests." });
      next.start(third.turn.id);
      expect(provider.runCount).toBe(2);
      expect(provider.input?.prompt).not.toContain(notice);
      const noted = reopened.turnExecutionManifest(second.turn.id)!;
      const plain = reopened.turnExecutionManifest(third.turn.id)!;
      expect(noted.internalInstructionCount).toBe(plain.internalInstructionCount + 1);
      expect(noted.internalInstructionBytes).toBeGreaterThan(plain.internalInstructionBytes);
    } finally {
      await next.dispose();
      reopened.close();
    }
  });
});
