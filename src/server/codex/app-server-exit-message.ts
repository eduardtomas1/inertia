import { providerProcessExitGuidance, providerProcessExitStatus } from "../provider/process-exit-guidance";

/**
 * Names how the App Server ended. Its stderr only selects the guidance and
 * stays in the technical detail.
 */
export function codexAppServerExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const status = providerProcessExitStatus(code, signal);
  const guidance = providerProcessExitGuidance(stderr);
  return signal
    ? `Codex App Server stopped unexpectedly${status}. ${guidance}`
    : `Codex App Server exited${status} before the turn completed. ${guidance}`;
}
