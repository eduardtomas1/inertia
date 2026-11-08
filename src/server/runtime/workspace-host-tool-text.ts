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
 * 2. credential-shaped values are replaced with `[redacted]`: values a
 *    credential name marks (`DB_PASSWORD=`, `password:`, `apiKey = "..."`),
 *    then the shared subagent scrubber, or the command scrubber for Run
 *    action commands;
 * 3. the chat's workspace root becomes `<workspace>`, the home directory
 *    `<home>`, and other user, temporary and (for commands) any absolute
 *    paths `<path>`, in any spelling: either slash, JSON-escaped,
 *    percent-encoded, or behind `file://` and `\\?\` prefixes;
 * 4. instruction-shaped text is neutralized as for cross-chat reads; and
 * 5. the result is cut to a UTF-8 byte limit. Neutralizing first keeps every
 *    prefix neutral, so truncating afterwards stays safe.
 */

export interface WorkspaceTextScope {
  /** Absolute workspace and repository roots, shown as `<workspace>`. */
  roots: readonly string[];
  homeDirectory?: string;
  /** Path rules to apply; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

/**
 * Separators as they appear in prose, JSON-escaped text and URLs: runs of
 * either slash on Windows, and their percent-encoded forms.
 */
const WINDOWS_SEPARATOR = String.raw`(?:[\\/]|%5[Cc]|%2[Ff])+`;
const POSIX_SEPARATOR = String.raw`(?:\\*\/|%2[Ff])+`;
/** One path segment: no separator, no delimiter, and no encoded separator. */
const WINDOWS_SEGMENT = String.raw`(?:[^\\/\s"'\x60,;()<>[\]{}%]|%(?!5[Cc]|2[Ff]))+`;
const POSIX_SEGMENT = String.raw`(?:[^/\s"'\x60,;:()<>[\]{}%]|%(?!2[Ff]))+`;
/**
 * A profile folder after `Users` or `home`. It may contain spaces
 * (`Alice Cooper`) when another segment or a closing quote follows, so the
 * whole name is redacted rather than only its first word.
 */
function userSegment(segment: string, separator: string): string {
  return String.raw`(?:${segment}(?: ${segment}){1,7}(?=${separator}|["'\x60])|${segment})`;
}
/** `file://`, `file:///`, `\\?\` and `//?/` (also JSON-escaped) before a drive. */
const WINDOWS_PATH_PREFIX = String.raw`(?:file:\/{2,3}|[\\/]{2,4}\?[\\/]{1,2})?`;
const WINDOWS_DRIVE = String.raw`[A-Za-z](?::|%3[Aa])`;
const USER_PATH_WINDOWS = new RegExp(
  String.raw`(?<![\w.])${WINDOWS_PATH_PREFIX}${WINDOWS_DRIVE}${WINDOWS_SEPARATOR}(?:`
    + String.raw`(?:Users|Documents and Settings|DOCUME~1)${WINDOWS_SEPARATOR}${userSegment(WINDOWS_SEGMENT, WINDOWS_SEPARATOR)}(?:${WINDOWS_SEPARATOR}${WINDOWS_SEGMENT})*`
    + String.raw`|(?:Temp|Windows${WINDOWS_SEPARATOR}Temp)(?:${WINDOWS_SEPARATOR}${WINDOWS_SEGMENT})+`
    + ")",
  "giu",
);
const USER_PATH_POSIX = new RegExp(
  String.raw`(?<![\w.:/~<>-])(?:file:\/\/)?${POSIX_SEPARATOR}(?:`
    + String.raw`(?:Users|home)${POSIX_SEPARATOR}${userSegment(POSIX_SEGMENT, POSIX_SEPARATOR)}(?:${POSIX_SEPARATOR}${POSIX_SEGMENT})*`
    + String.raw`|(?:root|private${POSIX_SEPARATOR}tmp|private${POSIX_SEPARATOR}var|tmp|var${POSIX_SEPARATOR}folders)(?:${POSIX_SEPARATOR}${POSIX_SEGMENT})+`
    + ")",
  "gu",
);
const ANY_PATH_POSIX = /(?<![\w.:/~<>-])\/(?:[^\s"'\\/]+\/)+([^\s"'\\/]+)/gu;
const ANY_PATH_WINDOWS = /(?<![\w.])[A-Za-z]:\\(?:[^\\\s"']+\\)+([^\\\s"']+)/gu;
const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Characters that end a path in prose, commands, and diffs. */
const PATH_DELIMITERS = String.raw`\s"'\x60,;()<>\[\]{}`;

/**
 * Names that hold a credential in `.env` files, configuration and code:
 * `DB_PASSWORD`, `STRIPE_API_KEY`, `GITHUB_TOKEN`, `clientSecret`, `password`.
 * Upper-case environment names ending in `KEY` count too; a lower-case `key`
 * (a JSX list key, a map key) does not.
 */
const SECRET_NAME = /(?:password|passwd|passphrase|secret|token|credentials?|authorization|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)$/iu;
const ENVIRONMENT_KEY_NAME = /^[A-Z][A-Z0-9_]*KEY$/u;
/** `NAME=value` with no spaces, as in `.env` files and shell lines. */
const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,80})=("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gu;
/** `NAME = "value"` or `NAME: 'value'`, where the value is a quoted literal. */
const QUOTED_SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1([ \t]*[:=][ \t]*)("[^"\r\n]*"|'[^'\r\n]*')/gu;
/** `password: hunter2`, `GITHUB_TOKEN: abc`, `Authorization: Bearer abc` (YAML and headers). */
const SECRET_HEADER = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,80})([ \t]*:(?![:/=])[ \t]*)((?:(?:Bearer|Basic|Token|Digest|Bot)[ \t]+)?)([^\s'"]+)/gu;
/** Type annotations such as `password: string;` and empty literals are not credentials. */
const TYPE_NAME = /^(?:string|number|boolean|bigint|symbol|object|unknown|any|never|null|undefined|void|true|false)(?:\[\])?[;,|)]?$/u;

function secretName(name: string): boolean {
  return SECRET_NAME.test(name) || ENVIRONMENT_KEY_NAME.test(name);
}

/**
 * Credential assignments in multi-line workspace text. The shared scrubber
 * catches token shapes; these passes catch values that only their name marks
 * as secret, one line at a time.
 */
function scrubSecretAssignments(text: string): string {
  return text
    .replace(SECRET_HEADER, (match: string, name: string, separator: string, scheme: string, value: string) =>
      secretName(name) && !TYPE_NAME.test(value) && value !== "[redacted]"
        ? `${name}${separator}${scheme}[redacted]`
        : match)
    .replace(QUOTED_SECRET_ASSIGNMENT, (match: string, quote: string, name: string, separator: string, value: string) =>
      secretName(name) ? `${quote}${name}${quote}${separator}${value[0]}[redacted]${value[0]}` : match)
    .replace(SECRET_ASSIGNMENT, (match: string, name: string) =>
      secretName(name) ? `${name}=[redacted]` : match);
}

/**
 * The credential passes every `inertia.workspace` text goes through. Named
 * assignments go first, so a quoted value is redacted whole before the shared
 * scrubber's shorter `API_KEY: value` form could cut it at a space.
 */
function scrubWorkspaceSecrets(text: string): string {
  return scrubSubagentSecrets(scrubSecretAssignments(text));
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Matches `root` in any spelling the platform can produce. On Windows that is
 * either separator, runs of them (JSON-escaped text doubles backslashes), any
 * letter case including the drive letter, and a trailing separator. A root
 * must end at a separator or a delimiter, so `C:\a\workspace` never matches
 * inside `C:\a\workspace2`, and must not continue another path.
 */
function rootPattern(root: string, platform: NodeJS.Platform): RegExp | null {
  const windows = platform === "win32";
  const separator = windows ? String.raw`[\\/]` : "/";
  const parts = root.split(windows ? /[\\/]+/u : /\/+/u).filter(Boolean);
  // A root of one segment ("/", "C:") would rewrite every absolute path.
  if (parts.length < (windows && /^[A-Za-z]:$/u.test(parts[0] ?? "") ? 2 : 1)) return null;
  const leadingSeparators = /^[\\/]*/u.exec(root)![0].length;
  const leading = leadingSeparators === 0
    ? ""
    : windows && leadingSeparators >= 2 ? `${separator}{2}` : separator;
  // Text before the root must not be part of a longer path or name, other
  // than a `file://` or `\\?\` prefix.
  const before = String.raw`(?:(?<![\w.~\\/-])|(?<=file:\/\/\/?)|(?<=[\\/]{2,4}\?[\\/]{1,2}))`;
  const body = parts.map(escaped).join(`${separator}+`);
  // The rest of the path, up to a delimiter or a ":line" suffix.
  const rest = String.raw`[^${PATH_DELIMITERS}:]*`;
  return new RegExp(
    `${before}${leading}${body}(?:(${separator}+)(${rest}))?(?=$|[${PATH_DELIMITERS}:])`,
    windows ? "giu" : "gu",
  );
}

function replaceRoot(text: string, root: string, replacement: string, platform: NodeJS.Platform): string {
  const pattern = rootPattern(root, platform);
  if (!pattern) return text;
  const separators = platform === "win32" ? /[\\/]+/gu : /\/+/gu;
  return text.replace(pattern, (_match, run: string | undefined, rest: string | undefined) =>
    run === undefined
      ? replacement
      // The separator run after the root becomes one "/"; on Windows, so do
      // the backslashes in the rest of the path.
      : `${replacement}/${(rest ?? "").replace(separators, "/")}`);
}

function scrubPaths(text: string, scope: WorkspaceTextScope, anyPath: boolean): string {
  let result = text;
  const platform = scope.platform ?? process.platform;
  const roots = [...new Set(scope.roots.filter(Boolean))].sort((left, right) => right.length - left.length);
  for (const root of roots) result = replaceRoot(result, root, "<workspace>", platform);
  result = replaceRoot(result, scope.homeDirectory ?? homedir(), "<home>", platform);
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
  const scrubbed = scrubPaths(scrubWorkspaceSecrets(stripTerminalControlSequences(value)), scope, false);
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
  const scrubbed = scrubPaths(scrubWorkspaceSecrets(value.replace(LINE_CONTROLS, "?")), scope, false);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed), maximumBytes).text;
}

/** UTF-8 bytes of a value once encoded in a JSON result. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
