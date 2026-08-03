import type { DuoGitRecoveryAction } from "@shared/contracts";

export type RecoveryCommandShell = "posix" | "powershell";

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function recoveryCommandShell(
  action: DuoGitRecoveryAction,
  userAgent = navigator.userAgent,
): RecoveryCommandShell {
  return /^[A-Za-z]:[\\/]/u.test(action.cwd)
      || /Windows/iu.test(userAgent)
    ? "powershell"
    : "posix";
}

/** A single copyable command with every path and argument shell-quoted. */
export function formatDuoRecoveryCommand(
  action: DuoGitRecoveryAction,
  shell: RecoveryCommandShell,
): string {
  const quote = shell === "powershell" ? quotePowerShell : quotePosix;
  return [
    action.executable,
    "-C",
    quote(action.cwd),
    ...action.args.map(quote),
  ].join(" ");
}
