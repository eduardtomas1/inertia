import type { AgentHarnessId } from "./agent-harness";

/**
 * Whether a harness can continue a native session from a checkout other than
 * the one the session last ran in.
 *
 * - `resume`: the harness resumes the session by id and runs it in the new
 *   checkout, so a chat that moves keeps its native conversation and receives
 *   only the items it has not seen (T3 `restart_and_resume`).
 * - `fresh`: not proven for this harness. A turn in another checkout starts a
 *   fresh session with the chat's portable history; the session stays usable
 *   in the checkout it belongs to.
 */
export type SessionCwdMobility = "resume" | "fresh";

/** Every harness is listed, so a new harness has to choose; only proven harnesses resume. */
const SESSION_CWD_MOBILITY: Readonly<Record<AgentHarnessId, SessionCwdMobility>> = {
  // `thread/resume` carries the run's `cwd` (src/server/codex/app-server-run.ts), and
  // App Server finds the thread by id under CODEX_HOME rather than by folder.
  "codex-app-server": "resume",
  // `codex exec resume` with another folder is not covered by a fixture.
  "codex-cli": "fresh",
  // Claude Code keeps each transcript under the project folder named after the
  // session's cwd; Inertia resumes an imported session from its original cwd
  // (src/server/cli-import/resume-cwd.ts). A resume from another cwd is unverified.
  "claude-agent-sdk": "fresh",
  "claude-cli": "fresh",
  // findPiSessionFile refuses a session whose header names another workspace.
  // T3 forks the session file into the new cwd (bebaf3ec0); not adopted yet.
  "pi-rpc": "fresh",
  // CursorSdkSession refuses a stored agent whose cwd is another workspace.
  // T3 resumes from the recorded store cwd (a18a458f2); not adopted yet.
  "cursor-sdk": "fresh",
  "cursor-acp": "fresh",
  "cursor-cli": "fresh",
  "kimi-acp": "fresh",
  "grok-acp": "fresh",
  "opencode-sdk": "fresh",
  "opencode-cli": "fresh",
  "antigravity-cli": "fresh",
};

export function sessionCwdMobility(harnessId: string): SessionCwdMobility {
  return Object.hasOwn(SESSION_CWD_MOBILITY, harnessId)
    ? SESSION_CWD_MOBILITY[harnessId as AgentHarnessId]
    : "fresh";
}
