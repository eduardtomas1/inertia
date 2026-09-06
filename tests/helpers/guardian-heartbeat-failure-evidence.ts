import type { ChildProcess } from "node:child_process";

import type { TestContext } from "vitest";

export function recordGuardianHeartbeatFailure(
  child: ChildProcess,
  onTestFailed: TestContext["onTestFailed"],
) {
  const startedAt = performance.now();
  const phases: { phase: string; elapsedMs: number }[] = [];
  let stderrTail = "";
  const recordPhase = (phase: string) => {
    phases.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
  };
  recordPhase("spawned");
  child.once("exit", () => recordPhase("child-exit"));
  child.stderr?.on("data", (chunk: Buffer) => {
    // Keep draining after the retained tail fills so diagnostics never
    // introduce child stderr backpressure into this lifecycle assertion.
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-16_384);
  });
  onTestFailed(() => {
    process.stderr.write(`Guardian heartbeat compromise failure: ${JSON.stringify({
      phases,
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stderrTail,
    })}\n`);
  });
  return recordPhase;
}
