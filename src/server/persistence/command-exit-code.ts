import type { ProviderId } from "../../shared/contracts";

const COMMAND_SECTION = "Command:\n";
const ERROR_SECTION = "Error:\n";
const EXIT_CODE_LINE = /^Exit code:? (-?\d{1,6})$/u;

export function recordedCommandExitCode(
  providerId: ProviderId,
  status: string,
  detail: string | null,
): number | null {
  if (providerId !== "claude" || status !== "failed" || detail === null) return null;
  let errorStart: number;
  if (detail.startsWith(ERROR_SECTION)) {
    errorStart = ERROR_SECTION.length;
  } else if (detail.startsWith(COMMAND_SECTION)) {
    const separator = detail.indexOf("\n\n", COMMAND_SECTION.length);
    if (separator === -1 || !detail.startsWith(ERROR_SECTION, separator + 2)) return null;
    errorStart = separator + 2 + ERROR_SECTION.length;
  } else {
    return null;
  }
  const lineEnd = detail.indexOf("\n", errorStart);
  const match = EXIT_CODE_LINE.exec(detail.slice(errorStart, lineEnd === -1 ? undefined : lineEnd));
  return match ? Number(match[1]) : null;
}
