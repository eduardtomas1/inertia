import { basename } from "node:path";

const WINDOWS_EXECUTABLE_EXTENSION = /\.(?:bat|cmd|exe|ps1)$/iu;

/**
 * Cursor ships both a dedicated `cursor-agent` binary and an editor launcher.
 * The latter exposes agent commands beneath its `agent` subcommand.
 */
export function cursorAgentCommandArgs(
  executable: string,
  args: readonly string[],
): string[] {
  const stem = basename(executable)
    .replace(WINDOWS_EXECUTABLE_EXTENSION, "")
    .toLowerCase();
  return stem === "cursor" ? ["agent", ...args] : [...args];
}
