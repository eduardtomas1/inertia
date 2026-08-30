import {
  DARWIN_RUNTIME_OWNED_GUARDIAN_ADMISSION_TIMEOUT_MS,
} from "../node/runtime-owned-process-darwin.js";
import {
  LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS,
} from "../node/runtime-owned-process-linux.js";
import { runtimeShutdownDeadlineMs } from "../node/runtime-shutdown-deadline.js";

export function terminalShutdownTimeoutMs(platform: NodeJS.Platform): number {
  // node-pty's Windows ConPTY backend intentionally delays its public exit
  // event for 1 second while output drains. Leave a second bounded interval
  // for a loaded host to deliver that signal and retire the durable process
  // claim before a runtime restart or database cleanup proceeds.
  if (platform === "win32") return 3_000;
  // The native macOS guardian can legitimately consume about 1.76 seconds in
  // its bounded worst case: two stable 16-pass freezes, a 5-poll TERM grace,
  // the post-KILL commit poll, and a 50-poll drain, all at 20 ms. Preserve
  // bounded scheduler/identity headroom, including one retry of the exact
  // guardian identity helper, instead of declaring that still-live proof
  // operation unsafe under host load. An outer runtime-shutdown deadline
  // remains authoritative and can tighten this.
  if (platform === "darwin") return 5_000;
  return 1_000;
}

export function terminalCloseTimeoutMs(platform: NodeJS.Platform): number {
  if (platform === "darwin") {
    // Guardian admission and native stop proof can consume 10.5 seconds.
    // Reuse the reviewed runtime envelope's remaining 2.25 seconds so the
    // child close event can retire its durable journal claim before an
    // ordinary close is declared unsafe under host load.
    return Math.max(
      runtimeShutdownDeadlineMs(platform),
      DARWIN_RUNTIME_OWNED_GUARDIAN_ADMISSION_TIMEOUT_MS
        + terminalShutdownTimeoutMs(platform),
    );
  }
  if (platform === "linux") {
    return LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS
      + 2 * terminalShutdownTimeoutMs(platform);
  }
  // Windows uses the runtime-owned process admission phases too. Preserve its
  // complete bounded runtime envelope for an ordinary close,
  // while keeping the shorter timeout above for each post-admission stop
  // proof. An active runtime shutdown still supplies the authoritative
  // absolute deadline and can tighten this local envelope.
  return runtimeShutdownDeadlineMs(platform);
}
