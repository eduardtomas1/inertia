// macOS privacy protection (TCC) refuses a CLI the project folder with EPERM.
const PERMISSION_DENIED_OUTPUT = /\bEPERM\b|Operation not permitted/u;

/**
 * What to do after a provider CLI exits on its own. Only recognises the
 * output; the output itself stays out of the message.
 */
export function providerProcessExitGuidance(output: unknown): string {
  return typeof output === "string" && PERMISSION_DENIED_OUTPUT.test(output)
    ? "It was denied access to a file or folder (EPERM). On macOS, allow Inertia under System Settings > Privacy & Security > Files and Folders, or move the project out of Desktop, Documents, or Downloads, then retry the turn."
    : "Check the details for the provider's output, then retry the turn.";
}

/** How a provider process ended, as a clause such as " with code 1". */
export function providerProcessExitStatus(
  code: number | null | undefined,
  signal: string | null | undefined,
): string {
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) {
    return ` after signal ${signal}`;
  }
  return typeof code === "number" && Number.isSafeInteger(code) ? ` with code ${code}` : "";
}
