import { describe, expect, it, vi } from "vitest";
import {
  guardianCloseDiagnostic, OWNED_PROCESS_TAINT_STAGES, parseRuntimeOwnedProcessDiagnostic,
} from "../../src/node/runtime-owned-process-diagnostic";
import { taintRuntimeOwnedProcessRegistry } from "../../src/node/runtime-owned-process-taint";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

describe("owned-process first-cause diagnostics", () => {
  it.each(OWNED_PROCESS_TAINT_STAGES)("relays fixed stage %s through the validated lifecycle event", (stage) => {
    const event = { type: "runtime.restart-requested", reason: "owned-process-tainted", diagnostic: { stage } };
    expect(parseRuntimeWorkerEvent(event)).toEqual(event);
  });

  it.each([
    null, {}, { stage: "PRIVATE" }, { stage: ["darwin-readiness"] },
    { stage: "darwin-readiness", argv: ["PRIVATE"] },
    { stage: "darwin-guardian-close", signal: "PRIVATE" },
    { stage: "darwin-guardian-close", exitCode: -1 },
    { stage: "darwin-guardian-close", exitCode: 256 },
    { stage: "darwin-guardian-close", exitCode: 1.5 },
    { stage: "darwin-guardian-close", exitCode: Infinity },
  ])("rejects malformed or content-bearing diagnostic %j", (diagnostic) => {
    expect(parseRuntimeOwnedProcessDiagnostic(diagnostic)).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.restart-requested", reason: "owned-process-tainted", diagnostic })).toBeNull();
  });

  it("records only the first taint even if reporting fails", () => {
    const onTainted = vi.fn(() => { throw new Error("PRIVATE"); });
    const registry = { tainted: false, onTainted };
    taintRuntimeOwnedProcessRegistry(registry, true, { stage: "darwin-readiness" });
    taintRuntimeOwnedProcessRegistry(registry, true, { stage: "darwin-guardian-close", signal: "SIGKILL" });
    expect(registry.tainted).toBe(true);
    expect(onTainted).toHaveBeenCalledExactlyOnceWith({ stage: "darwin-readiness" });
  });

  it("does not notify an inactive registry or change guardian signal meaning", () => {
    const registry = { tainted: false, onTainted: vi.fn() };
    taintRuntimeOwnedProcessRegistry(registry, false, { stage: "linux-admission" });
    expect(registry.tainted).toBe(true);
    expect(registry.onTainted).not.toHaveBeenCalled();
    expect(guardianCloseDiagnostic("darwin-guardian-close", "SIGUSR2", null)).toEqual({ stage: "darwin-guardian-close", signal: "SIGUSR2" });
    expect(guardianCloseDiagnostic("darwin-guardian-close", "SIGKILL", 0)).toEqual({ stage: "darwin-guardian-close", signal: "SIGKILL", exitCode: 0 });
    expect(guardianCloseDiagnostic("darwin-guardian-close", "PRIVATE", 256)).toEqual({ stage: "darwin-guardian-close", signal: "other" });
    expect(parseRuntimeWorkerEvent({ type: "runtime.restart-requested", reason: "owned-process-cleanup-unconfirmed", diagnostic: { stage: "darwin-readiness" } })).toBeNull();
  });
});
