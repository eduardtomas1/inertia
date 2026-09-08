// Scratch-only observer. Imported by the smoke script after production packaging.
import { sanitizeRuntimeDiagnosticText } from "./pr321-runtime-text-sanitizer.mjs";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const exactBranch = "refs/heads/codex/validation-pr321-installed-turn-start";
const boundedText = (value) => {
  if (typeof value !== "string") return undefined;
  let text = value.slice(0, 4096);
  const root = process.env.INERTIA_PACKAGE_SMOKE_STATE_ROOT;
  if (root) text = text.replaceAll(root, "<fixture-root>");
  return sanitizeRuntimeDiagnosticText(text);
};
const known = (value, values) => values.includes(value) ? value : "other";
const count = (value) => Number.isSafeInteger(value) && value >= 0
  ? Math.min(value, 4096) : null;

export function createTurnObserver() {
  const enabled = process.platform === "win32"
    && process.env.GITHUB_REPOSITORY === "eduardtomas1/inertia"
    && process.env.GITHUB_REF === exactBranch
    && process.env.INERTIA_PACKAGE_SMOKE_HISTORY_MODE === "verify"
    && Boolean(process.env.INERTIA_PACKAGE_SMOKE_STATE_ROOT);
  const events = [];
  const started = performance.now();
  let emitted = false;
  return {
    observe(event) {
      if (!enabled) return;
      if (event.type === "agent.failed" || event.type === "request.error") {
        events.push({ type: event.type, turnId: event.turnId,
          requestId: event.requestId, message: boundedText(event.message),
          terminalReason: boundedText(event.terminalReason),
          elapsedMs: Math.round(performance.now() - started) });
      } else if (event.type === "agent.activity" && event.activity?.kind === "error") {
        events.push({ type: event.type, turnId: event.activity.turnId,
          message: boundedText(event.activity.title),
          elapsedMs: Math.round(performance.now() - started) });
      }
      if (events.length > 16) events.shift();
    },
    failed(value, acceptance, snapshot, phase) {
      if (!enabled || emitted) return;
      emitted = true;
      try {
        const turn = value.agentTurns.find(({ id }) => id === acceptance?.turnId);
        const run = snapshot?.runs?.find(({ id }) => id === turn?.runId);
        const provider = snapshot?.providers?.find(({ id }) => id === "codex");
        const owned = snapshot?.lifecycleDiagnostics?.ownedResources;
        const record = {
          schema: 1, source: "3be5a9ce64f776969ebc23f87a44ad52c70a4641",
          phase: known(phase, ["initial Fast", "Fast-to-Standard", "Standard-to-Fast", "post-compaction Fast resume"]),
          elapsedMs: Math.round(performance.now() - started),
          terminalReason: boundedText(turn?.terminalReason),
          status: known(turn?.status, ["failed", "completed", "cancelled", "interrupted"]),
          exactTurn: Boolean(turn && turn.conversationId === acceptance.conversationId),
          providerSessionBeforePresent: Boolean(turn?.providerSessionBefore),
          providerSessionAfterPresent: Boolean(turn?.providerSessionAfter),
          fastMode: known(turn?.modelSelection?.providerOptions?.fastMode, ["priority"]),
          providerInstalled: provider?.installState === "installed", providerCanRun: provider?.canRun === true,
          providerStatus: boundedText(provider?.statusMessage),
          runStatus: known(run?.status, ["starting", "running", "failed", "succeeded", "cancelled"]),
          runDetail: boundedText(run?.detail),
          errors: (value.activities ?? []).filter((activity) => activity.kind === "error"
            && activity.turnId === turn?.id && activity.runId === turn?.runId)
            .slice(-4).map((activity) => boundedText(activity.title)),
          events: events.filter((event) => event.type === "request.error" || event.turnId === turn?.id)
            .map(({ type, message, terminalReason, elapsedMs }) => ({ type, message, terminalReason, elapsedMs })),
          owned: Object.fromEntries(["providerRuns", "turns", "workspaceRuns", "interactions"]
            .map((key) => [key, count(owned?.[key])])),
        };
        const serialized = JSON.stringify(record);
        if (Buffer.byteLength(serialized) <= 16 * 1024) {
          console.error(`PR321_INSTALLED_TURN_FAILURE ${serialized}`);
          try {
            writeFileSync(resolve("diagnostic-results/candidate-turn-failure.json"), serialized,
              { encoding: "utf8", mode: 0o600, flag: "wx" });
          } catch {
            // The retained bounded stderr remains evidence; preserve the original error.
          }
        }
      } catch {
        console.error("PR321_INSTALLED_TURN_FAILURE {\"schema\":1,\"captureFailed\":true}");
      }
    },
  };
}
