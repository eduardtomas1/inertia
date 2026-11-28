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
  // `--resume <id>` with the new cwd: Claude Code finds the transcript in the
  // cwd's project folder, then in its git worktrees' folders, then in the only
  // project folder of the Claude home that holds it, and keeps appending to that
  // file (observed with 2.1.299 and the bundled 2.1.319; fixtures in
  // tests/server/claude-moved-checkout-resume.test.ts). An older Claude Code
  // (2.1.98) answers "No conversation found with session ID", which starts the
  // turn fresh with the portable history (G9 fallback).
  "claude-agent-sdk": "resume",
  "claude-cli": "resume",
  // Pi records the checkout a session was created in; the harness continues a `pi --fork` copy made in
  // the new checkout and the backing follows the copy (`provider.backing-forked`; T3 bebaf3ec0).
  "pi-rpc": "resume",
  // Cursor keys its store by checkout: a moved chat's agent is resumed from the store of the checkout
  // it was created in (`sessionOriginCwd`: the oldest run that ended on it) and runs in the new one (T3 a18a458f2).
  "cursor-sdk": "resume",
  "cursor-acp": "fresh",
  "cursor-cli": "fresh",
  "kimi-acp": "fresh",
  "grok-acp": "fresh",
  "opencode-sdk": "fresh",
  "opencode-cli": "fresh",
  "antigravity-acp": "fresh",
  "antigravity-cli": "fresh",
};

export function sessionCwdMobility(harnessId: string): SessionCwdMobility {
  return Object.hasOwn(SESSION_CWD_MOBILITY, harnessId)
    ? SESSION_CWD_MOBILITY[harnessId as AgentHarnessId]
    : "fresh";
}
