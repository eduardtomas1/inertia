import type {
  CodexSubagentAuthority,
  CodexSubagentProjection,
  CodexSubagentUpdate,
} from "./app-server-subagents";

const SUBAGENT_AUTHORITY: Record<CodexSubagentAuthority, number> = {
  activity: 0,
  state: 1,
  turn: 2,
};

const LIVE_SUBAGENT_STATUSES = new Set<CodexSubagentUpdate["status"]>([
  "queued",
  "spawned",
  "running",
  "waiting",
]);

const TERMINAL_SUBAGENT_STATUSES =
  new Set<CodexSubagentUpdate["status"]>([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
    "lost",
  ]);

export function isLiveCodexSubagentStatus(
  status: CodexSubagentUpdate["status"],
): boolean {
  return LIVE_SUBAGENT_STATUSES.has(status);
}

export function shouldAcceptCodexSubagentProjection(
  current: CodexSubagentProjection | undefined,
  update: Pick<CodexSubagentUpdate, "status">,
  authority: CodexSubagentAuthority,
  isLive: boolean,
): boolean {
  if (!current) return true;
  const weaker =
    SUBAGENT_AUTHORITY[authority] < SUBAGENT_AUTHORITY[current.authority];
  const stronger =
    SUBAGENT_AUTHORITY[authority] > SUBAGENT_AUTHORITY[current.authority];
  const clarifiesUnknown =
    current.status === "unknown"
    && update.status !== "unknown"
    && SUBAGENT_AUTHORITY[authority] >= SUBAGENT_AUTHORITY[current.authority];
  const authoritativelyRevivesTerminalUnknown =
    !current.isLive
    && isLive
    && current.status === "unknown"
    && update.status !== "unknown"
    && stronger;
  if (
    !current.isLive
    && isLive
    && !authoritativelyRevivesTerminalUnknown
  ) {
    return false;
  }
  if (
    TERMINAL_SUBAGENT_STATUSES.has(current.status)
    && (
      weaker
      || (
        !stronger
        && !clarifiesUnknown
        && update.status !== current.status
      )
    )
  ) {
    return false;
  }
  return true;
}
