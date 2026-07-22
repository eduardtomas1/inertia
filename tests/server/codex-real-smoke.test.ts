import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";

const enabled = process.env.INERTIA_REAL_CODEX_SMOKE === "1";
const executable = process.env.INERTIA_CODEX_EXECUTABLE
  ?? (process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : "codex");

describe("real Codex App Server smoke", () => {
  const roots: string[] = [];
  afterAll(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it.skipIf(!enabled || process.platform === "win32")(
    "streams a real supervised turn and denies a requested write",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-real-codex-"));
      roots.push(root);
      const manager = new ProviderManager({ commands: { codex: executable }, cancelGraceMs: 2_000 });
      const approvals: string[] = [];
      const lifecycle: string[] = [];
      const reasoningSummaries: string[] = [];
      const usageSamples: number[] = [];
      const contextWindows: number[] = [];
      let usedCancel = false;
      let responseAccepted = true;
      let watchdog: NodeJS.Timeout | undefined;

      const breadcrumb = (value: string): void => {
        lifecycle.push(value.slice(0, 160));
        console.info(`[real-codex-smoke] ${value.slice(0, 160)}`);
      };

      try {
        breadcrumb("starting");
        const metadata = await manager.metadata("codex", root);
        expect(metadata.models.length).toBeGreaterThan(0);
        expect(metadata.models.some((model) => model.reasoningOptions.length > 0)).toBe(true);
        breadcrumb(`metadata:${metadata.models.length}-models:${metadata.rateLimits.length}-limits`);
        const run = manager.run({
          providerId: "codex",
          conversationId: "real-codex-smoke",
          cwd: root,
          prompt: "Create a file named approval-smoke.txt containing the word denied. Use a shell command, do not use another tool, and do nothing else.",
          interactionMode: "build",
          access: "supervised",
        }, {
          onStatus: (event) => breadcrumb(`status:${event.status}`),
          onActivity: (event) => breadcrumb(`activity:${event.kind}:${event.phase}`),
          onReasoning: (event) => {
            reasoningSummaries.push(event.text);
            breadcrumb(`reasoning:${event.text}`);
          },
          onUsage: (event) => {
            usageSamples.push(event.usage.usedTokens);
            if (event.usage.maxTokens) contextWindows.push(event.usage.maxTokens);
            breadcrumb(`usage:${event.usage.usedTokens}/${event.usage.maxTokens ?? "unknown"}`);
          },
          onApproval: (event) => {
            approvals.push(event.request.kind);
            const decision = event.request.availableDecisions.includes("deny") ? "deny" : "cancel";
            usedCancel ||= decision === "cancel";
            breadcrumb(`approval:${event.request.kind}:decision:${decision}`);
            responseAccepted &&= manager.respondToApproval(event.conversationId, event.request.requestId, decision);
            if (!responseAccepted) manager.cancel(event.conversationId);
          },
          onInput: (event) => {
            breadcrumb(`input:${event.request.questions.length}`);
            const answers = Object.fromEntries(event.request.questions.map((question) => [question.id, ["Stop without making changes."]]));
            responseAccepted &&= manager.respondToInput(event.conversationId, event.request.requestId, answers);
            if (!responseAccepted) manager.cancel(event.conversationId);
          },
        });
        const timed = new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            breadcrumb("watchdog:cancel");
            manager.cancel("real-codex-smoke");
            reject(new Error(`Real Codex smoke watchdog expired (${lifecycle.join(" > ")}).`));
          }, 90_000);
          watchdog.unref();
        });
        const result = await Promise.race([run, timed]);

        expect(result).toMatchObject({ status: usedCancel ? "cancelled" : "completed" });
        expect(responseAccepted).toBe(true);
        expect(approvals.length).toBeGreaterThan(0);
        expect(usageSamples.some((tokens) => tokens > 0)).toBe(true);
        expect(contextWindows.some((tokens) => tokens > usageSamples[0])).toBe(true);
        expect(existsSync(join(root, "approval-smoke.txt"))).toBe(false);
        breadcrumb(`complete:${reasoningSummaries.length}-reasoning-summaries:${usageSamples.length}-usage-samples`);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        await manager.disposeAll();
      }
    },
    180_000,
  );
});
