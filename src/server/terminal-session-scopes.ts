export interface TerminalSessionScope {
  cwd: string;
  conversationId: string | null;
}

interface ScopedTerminalSession {
  cwd: string;
  exitObserved: boolean;
  reattachScope: { conversationId: string | null } | null;
  providerResume: { conversationId: string; cwd?: string } | null;
}

export function liveTerminalSessionScopes(sessions: Iterable<ScopedTerminalSession>): TerminalSessionScope[] {
  return [...sessions].filter((session) => !session.exitObserved).map((session) => ({
    cwd: session.providerResume?.cwd ?? session.cwd,
    conversationId: session.reattachScope?.conversationId ?? session.providerResume?.conversationId ?? null,
  }));
}
