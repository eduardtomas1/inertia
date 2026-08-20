import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { nativeProviderRunInput } from "./model-route-fixture";

const enabled = process.env.INERTIA_REAL_CLAUDE_SMOKE === "1";
const executable = process.env.INERTIA_CLAUDE_EXECUTABLE ?? "claude";

describe("real Claude Agent SDK smoke", () => {
  const roots: string[] = [];
  afterAll(() => roots.splice(0).forEach((root) =>
    rmSync(root, { recursive: true, force: true })));

  it.skipIf(!enabled || process.platform === "win32")(
    "completes an exact text-only turn and cleans up its owned session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-real-claude-"));
      roots.push(root);
      const manager = new ProviderManager({
        commands: { claude: executable },
        cancelGraceMs: 2_000,
      });
      const counts = {
        statuses: 0,
        activities: 0,
        reasoning: 0,
        usage: 0,
      };
      const unsupportedUpdates: string[] = [];
      let watchdog: NodeJS.Timeout | undefined;

      try {
        const run = manager.run(nativeProviderRunInput({
          providerId: "claude",
          conversationId: "real-claude-smoke",
          runId: "real-claude-smoke-run",
          turnId: "real-claude-smoke-turn",
          cwd: root,
          prompt:
            "Reply with exactly INERTIA_LIVE_SMOKE_OK and nothing else. Do not use tools.",
          interactionMode: "build",
          access: "supervised",
        }), {
          onStatus: () => { counts.statuses += 1; },
          onActivity: (event) => {
            counts.activities += 1;
            if (
              event.label === "Claude sent an unsupported SDK update"
              && event.detail
            ) unsupportedUpdates.push(event.detail.slice(0, 500));
          },
          onReasoning: () => { counts.reasoning += 1; },
          onUsage: () => { counts.usage += 1; },
        });
        const timed = new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            manager.cancel("real-claude-smoke");
            reject(new Error("Real Claude smoke watchdog expired."));
          }, 120_000);
          watchdog.unref();
        });
        const result = await Promise.race([run, timed]);

        console.info(`[real-claude-smoke] ${JSON.stringify({
          status: result.status,
          cleanupConfirmed: result.cleanupConfirmed,
          failure: result.failure
            ? {
                reason: result.failure.reason,
                phase: result.failure.phase,
                terminalEvent: result.failure.terminalEvent,
                message: result.failure.message.slice(0, 300),
              }
            : null,
          counts,
          unsupportedUpdates,
        })}`);

        expect(result).toMatchObject({
          status: "completed",
          cleanupConfirmed: true,
        });
        expect(result.text.trim()).toBe("INERTIA_LIVE_SMOKE_OK");
        expect(counts.statuses).toBeGreaterThan(0);
        expect(counts.usage).toBeGreaterThan(0);
        expect(unsupportedUpdates).toEqual([]);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        await manager.disposeAll();
      }
    },
    180_000,
  );
});
