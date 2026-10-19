import { homedir } from "node:os";

import { stripTerminalControlSequences } from "../provider/activity-detail";
import { scrubCommandSecrets } from "../provider/command-secrets";
import { scrubSubagentSecrets } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText, truncateUtf8 } from "./untrusted-agent-text";

/**
 * Text that `inertia.workspace` tools return comes from the workspace, from
 * provider plans, or from the user's own records. Before it reaches a model:
 *
 * 1. terminal escape sequences and C0/C1 controls are removed;
 * 2. credential-shaped values are replaced with `[redacted]` (the shared
 *    subagent scrubber, plus the command scrubber for Run action commands);
 * 3. the chat's workspace root becomes `<workspace>`, the home directory
 *    `<home>`, and other user, temporary and (for commands) any absolute
 *    paths `<path>`;
 * 4. instruction-shaped text is neutralized as for cross-chat reads; and
 * 5. the result is cut to a UTF-8 byte limit. Neutralizing first keeps every
 *    prefix neutral, so truncating afterwards stays safe.
 */

export interface WorkspaceTextScope {
  /** Absolute workspace and repository roots, shown as `<workspace>`. */
  roots: readonly string[];
  homeDirectory?: string;
}

const PATH_END = String.raw`(?=$|[\\/\s"'\x60,;:()<>\[\]{}])`;
const USER_PATH_POSIX = /(?<![\w.:/~<>-])\/(?:Users|home|root|private\/tmp|private\/var|tmp|var\/folders)(?:\/[^\s"'`,;:()<>[\]{}]+)+/gu;
const USER_PATH_WINDOWS = /(?<![\w.])[A-Za-z]:\\(?:Users|Temp|Windows\\Temp)(?:\\[^\\\s"'`,;()<>[\]{}]+)+/giu;
const ANY_PATH_POSIX = /(?<![\w.:/~<>-])\/(?:[^\s"'\\/]+\/)+([^\s"'\\/]+)/gu;
const ANY_PATH_WINDOWS = /(?<![\w.])[A-Za-z]:\\(?:[^\\\s"']+\\)+([^\\\s"']+)/gu;
const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replacePathPrefix(text: string, path: string | undefined, replacement: string): string {
  const normalized = path?.replace(/[\\/]+$/u, "");
  // A root of one segment ("/", "C:") would rewrite every absolute path.
  if (!normalized || normalized.replace(/^[A-Za-z]:/u, "").split(/[\\/]/u).filter(Boolean).length < 1) {
    return text;
  }
  const flags = process.platform === "win32" ? "giu" : "gu";
  return text.replace(new RegExp(`${escaped(normalized)}${PATH_END}`, flags), replacement);
}

function scrubPaths(text: string, scope: WorkspaceTextScope, anyPath: boolean): string {
  let result = text;
  const roots = [...new Set(scope.roots.filter(Boolean))].sort((left, right) => right.length - left.length);
  for (const root of roots) result = replacePathPrefix(result, root, "<workspace>");
  result = replacePathPrefix(result, scope.homeDirectory ?? homedir(), "<home>");
  result = result.replace(USER_PATH_POSIX, "<path>").replace(USER_PATH_WINDOWS, "<path>");
  if (anyPath) {
    result = result.replace(ANY_PATH_POSIX, "<path>/$1").replace(ANY_PATH_WINDOWS, "<path>\\$1");
  }
  return result;
}

export interface BoundedWorkspaceText {
  text: string;
  truncated: boolean;
}

/** Multi-line workspace text: diffs, plan documents, task notes. */
export function workspaceText(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): BoundedWorkspaceText {
  const scrubbed = scrubPaths(scrubSubagentSecrets(stripTerminalControlSequences(value)), scope, false);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed), maximumBytes);
}

/** A Run action command line; every absolute path keeps only its last segment. */
export function workspaceCommand(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): BoundedWorkspaceText {
  const scrubbed = scrubPaths(scrubCommandSecrets(stripTerminalControlSequences(value)), scope, true);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed.replace(/\s+/gu, " ").trim()), maximumBytes);
}

/**
 * One-line values: file paths, branch names, titles. Controls become `?`, as
 * Git prints them, so a crafted file name cannot start a new line.
 */
export function workspaceLabel(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): string {
  const scrubbed = scrubPaths(scrubSubagentSecrets(value.replace(LINE_CONTROLS, "?")), scope, false);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed), maximumBytes).text;
}

/** UTF-8 bytes of a value once encoded in a JSON result. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
