import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import WebSocket from "ws";
import type { AppSnapshot } from "../../../src/shared/contracts";
import type { AppFixture } from "./app-fixture";
import { settleOperationBounded } from "./electron-app-lifecycle";

// Diagnostic branch only. Observe existing public snapshots without changing
// admission, test assertions, provider replies, or application deadlines.
export async function attachReleaseFailureObservation(app: AppFixture, info: TestInfo): Promise<void> {
  if (info.status === info.expectedStatus && process.env.INERTIA_DIAGNOSTIC_RETAIN_BASELINES !== "1") return;
  await mkdir(info.outputDir, { recursive: true });
  const journal = join(app.testDirectory, "data", "provider-phases.jsonl");
  try {
    if ((await stat(journal)).size <= 256 * 1024) {
      const path = info.outputPath("synthetic-provider-phases.jsonl");
      await writeFile(path, await readFile(journal));
      await info.attach("synthetic-provider-phases", { path, contentType: "application/x-ndjson" });
    }
  } catch { /* a provider may not have reached its first recorded phase */ }
  let socket: WebSocket | undefined;
  try {
    const observedSupervisor = await settleOperationBounded(app.runtimeSnapshot(), 2_000);
    if (observedSupervisor.status !== "fulfilled") throw new Error("supervisor observation unavailable");
    const supervisor = observedSupervisor.value;
    if (!supervisor.websocketUrl) return;
    const snapshot = await new Promise<AppSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("snapshot observation deadline")), 2_000);
      socket = new WebSocket(supervisor.websocketUrl!, {
        headers: { Origin: "http://127.0.0.1" }, maxPayload: 1024 * 1024,
      });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString("utf8"));
          const event = frame?.type === "runtime.event" ? frame.event : frame;
          if (event?.type !== "server.welcome" && event?.type !== "snapshot.updated") return;
          clearTimeout(timer);
          resolve(event.snapshot as AppSnapshot);
        } catch { clearTimeout(timer); reject(new Error("invalid diagnostic snapshot")); }
      });
    });
    const report = {
      observedAt: Date.now(), supervisor: { phase: supervisor.phase, hasPid: supervisor.pid !== null },
      providers: snapshot.providers.slice(0, 10).map((p) => ({ id: p.id, installState: p.installState, canRun: p.canRun,
        models: p.metadataState.models })),
      conversations: snapshot.conversations.slice(0, 30).map((c) => ({ status: c.status,
        latestTurnStatus: c.latestTurn?.status,
        latestTurnRequestedAt: c.latestTurn?.requestedAt,
        latestTurnStartedAt: c.latestTurn?.startedAt,
        latestTurnCompletedAt: c.latestTurn?.completedAt,
      })),
      runs: snapshot.runs.slice(0, 40).map((r) => ({ kind: r.kind, status: r.status, canStop: r.canStop })),
      ownedResources: snapshot.lifecycleDiagnostics?.ownedResources,
      startupBlockerCodes: snapshot.lifecycleDiagnostics?.startupBlockerCodes,
      actionableState: snapshot.lifecycleDiagnostics?.actionableState,
    };
    const path = info.outputPath("runtime-state.json");
    await writeFile(path, JSON.stringify(report, null, 2));
    await info.attach("runtime-failure-state", { path, contentType: "application/json" });
  } catch {
    await info.attach("runtime-failure-state", { body: "Snapshot observation unavailable.", contentType: "text/plain" });
  } finally { socket?.terminate(); }
}
