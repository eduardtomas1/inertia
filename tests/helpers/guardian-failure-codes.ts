// Only fixed native guardian codes may enter failure artifacts. Terminal
// output is untrusted; these observations never authorize process cleanup.
const phases = new Set([
  "unknown", "freeze-initial-census", "freeze-stop-signal",
  "freeze-post-stop-census", "freeze-unstable-members", "term-signal",
  "term-census", "term-fork-taint", "kill-signal", "resume-direct-child",
  "resume-descendant", "drain-census", "drain-fork-taint", "drain-timeout",
  "forced-test-failure",
]);
const censusReasons = new Set([
  "none", "pid-buffer-allocation", "pid-list", "session-status-unreadable",
  "session-live-identity-unreadable", "tracked-status-unreadable",
  "tracked-live-identity-unreadable", "member-capacity", "owned-capacity",
]);

export interface GuardianFailureCode {
  readonly phase: string;
  readonly census: string;
}

export function collectGuardianFailureCodes(
  previous: readonly GuardianFailureCode[],
  payload: string | Buffer,
): readonly GuardianFailureCode[] {
  // Decode only bounded terminal frames, without retaining unrelated payloads.
  if (payload.length > 1_048_576) return previous;
  let message: unknown;
  try { message = JSON.parse(String(payload)); } catch { return previous; }
  if (!message || typeof message !== "object") return previous;
  if ("type" in message && message.type === "runtime.event" && "event" in message) {
    message = message.event;
  }
  if (!message || typeof message !== "object"
    || !("type" in message) || message.type !== "terminal.output"
    || !("data" in message) || typeof message.data !== "string") return previous;
  let result = previous;
  for (const match of message.data.matchAll(
    /\[Inertia guardian cleanup unproved: ([a-z-]{1,48})\/([a-z-]{1,48})\]/gu,
  )) {
    const phase = match[1]!;
    const census = match[2]!;
    if (!phases.has(phase) || !censusReasons.has(census)) continue;
    result = [...result.slice(-7), { phase, census }];
  }
  return result;
}
