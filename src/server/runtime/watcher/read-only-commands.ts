import { posix, win32 } from "node:path";

export const MAX_READ_ONLY_COMMAND_CHARS = 4_096;
export const MAX_READ_ONLY_COMMAND_ARGUMENTS = 256;
export const WATCHER_COMMAND_ENVIRONMENT = Object.freeze({ GIT_OPTIONAL_LOCKS: "0" });

export interface ReadOnlyCommandContext {
  cwd: string;
  windows: boolean;
  powershell?: boolean;
}

export type ReadOnlyCommandVerdict =
  | { allowed: true; program: string }
  | { allowed: false; reason: string };

interface Word {
  value: string;
  glob: boolean[];
}

type ProgramRule = (args: readonly string[], globbed: readonly boolean[]) => string | null;

const SHELL_SYNTAX = "The command uses shell syntax that watchers cannot run.";
const UNSAFE_OPTION = "The command uses an option that can write or run another program.";
const OUTSIDE = "The command reads outside the workspace.";
const ENVIRONMENT_FILE = "The command reads an environment file.";
const OPTION_GLOB = "The command uses a glob that could expand to an option.";
const UNIQ_GLOB = "uniq cannot take a glob, because a second matched file would become its output.";

const UNQUOTED_REJECTED = new Set([";", "&", "<", ">", "(", ")", "{", "}", "$", "\\"]);
const WORD_START_REJECTED = new Set(["#", "~", "="]);
const DOUBLE_QUOTED_REJECTED = new Set(["$", "\\"]);
const WINDOWS_REJECTED = new Set(["%", "^", "&", "|", "<", ">", "\"", "\\"]);
const GLOB = new Set(["*", "?", "["]);
const STDERR_REDIRECTS = ["2>/dev/null", "2>&1"];
const PROGRAM_PREFIXES = ["/usr/bin/", "/bin/"];
const ENVIRONMENT_FILE_NAME = /^\.env(?:$|\.)/u;

const GIT_UNSAFE_LONG = ["output", "ext-diff", "textconv", "open-files-in-pager", "exec", "upload-pack", "receive-pack", "filters"];
const GIT_READ_SUBCOMMANDS = new Set(["diff", "log", "show", "status", "blame", "grep", "ls-files", "rev-parse", "shortlog", "describe"]);
const GIT_BRANCH_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "--show-current", "-v", "-vv", "--verbose", "--no-color", "--no-abbrev"]);
const GIT_TAG_FLAGS = new Set(["--list", "-l", "-n", "--no-column", "--ignore-case", "-i"]);
const GIT_REF_FILTERS = ["--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at=", "--sort=", "--format="];
const GIT_CAT_FILE_MODES = new Set(["-p", "-t", "-s"]);
const GIT_WORKTREE_LIST_FLAGS = new Set(["--porcelain", "-v", "--verbose", "-z"]);
const FIND_UNSAFE = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"]);
const TAIL_OBSOLETE_FOLLOW = /^\+\d*[bcl]?f$/u;
const UNIQ_VALUE_OPTIONS = new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);

const PROGRAMS: Readonly<Record<string, ProgramRule>> = Object.freeze({
  git: gitRule,
  rg: optionRule({ long: ["pre", "pre-glob", "hostname-bin"] }),
  grep: noRule,
  egrep: noRule,
  fgrep: noRule,
  cat: optionRule({ short: "Ww" }),
  head: noRule,
  tail: tailRule,
  ls: noRule,
  find: findRule,
  wc: noRule,
  diff: noRule,
  stat: noRule,
  file: optionRule({ short: "C", long: ["compile"] }),
  tree: optionRule({ short: "oR", long: ["output"] }),
  pwd: noRule,
  which: noRule,
  echo: noRule,
  nl: noRule,
  cut: noRule,
  sort: optionRule({ short: "oT", long: ["output", "temporary-directory", "compress-program"] }),
  uniq: uniqRule,
  tr: noRule,
  column: noRule,
  jq: jqRule,
});

export function classifyReadOnlyCommand(command: string, context: ReadOnlyCommandContext): ReadOnlyCommandVerdict {
  if (command.length > MAX_READ_ONLY_COMMAND_CHARS) return refuse("The command is too long.");
  const segments = tokenize(command, context.windows, context.windows || context.powershell === true);
  if (typeof segments === "string") return refuse(segments);
  if (segments.flat().length > MAX_READ_ONLY_COMMAND_ARGUMENTS) return refuse("The command has too many arguments.");
  let first: string | null = null;
  for (const words of segments) {
    const verdict = classifySegment(words, context);
    if (!verdict.allowed) return verdict;
    first ??= verdict.program;
  }
  return first === null ? refuse(SHELL_SYNTAX) : { allowed: true, program: first };
}

function classifySegment(words: readonly Word[], context: ReadOnlyCommandContext): ReadOnlyCommandVerdict {
  const [head, ...rest] = words;
  if (!head) return refuse(SHELL_SYNTAX);
  if (head.glob.includes(true)) return refuse(SHELL_SYNTAX);
  const program = programName(head.value);
  if (program === null || !Object.hasOwn(PROGRAMS, program)) {
    return refuse(`${/^[A-Za-z0-9._-]{1,64}$/u.test(head.value) ? head.value : "This program"} is not a read-only command watchers can run.`);
  }
  const rule = PROGRAMS[program]!;
  for (const word of rest) {
    if (globShapesOption(word)) return refuse(OPTION_GLOB);
    const problem = pathProblem(word, context, program !== "git");
    if (problem) return refuse(problem);
  }
  const problem = rule(rest.map(({ value }) => value), rest.map(({ glob }) => glob.includes(true)));
  return problem ? refuse(problem) : { allowed: true, program };
}

function programName(value: string): string | null {
  const prefix = PROGRAM_PREFIXES.find((candidate) => value.startsWith(candidate));
  const name = prefix ? value.slice(prefix.length) : value;
  return /^[a-z][a-z0-9-]*$/u.test(name) ? name : null;
}

function tokenize(command: string, windows: boolean, powershell: boolean): Word[][] | string {
  const segments: Word[][] = [[]];
  let word: Word | null = null;
  let quote: "'" | "\"" | null = null;
  const characters = [...command];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (!permittedCharacter(character)) return SHELL_SYNTAX;
    if (windows && WINDOWS_REJECTED.has(character) && !(character === "|" && quote === null)) return SHELL_SYNTAX;
    if (quote === "'") {
      if (character === "'") quote = null;
      else append(word!, character, false);
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") quote = null;
      else if (DOUBLE_QUOTED_REJECTED.has(character)) return SHELL_SYNTAX;
      else append(word!, character, false);
      continue;
    }
    if (character === " " || character === "\t") {
      if (word) segments.at(-1)!.push(word);
      word = null;
      continue;
    }
    if (character === "|") {
      if (characters[index + 1] === "|") return SHELL_SYNTAX;
      if (word) segments.at(-1)!.push(word);
      word = null;
      if (segments.at(-1)!.length === 0) return SHELL_SYNTAX;
      segments.push([]);
      continue;
    }
    const redirect = !windows && !word && segments.at(-1)!.length > 0
      ? STDERR_REDIRECTS.find((candidate) => characters.slice(index, index + candidate.length).join("") === candidate
        && /^(?:[ \t|]|$)/u.test(characters[index + candidate.length] ?? ""))
      : undefined;
    if (redirect) {
      index += redirect.length - 1;
      continue;
    }
    if (UNQUOTED_REJECTED.has(character)) return SHELL_SYNTAX;
    if (!word && WORD_START_REJECTED.has(character)) return SHELL_SYNTAX;
    if (character === "~" && /[=:]$/u.test(word?.value ?? "")) return SHELL_SYNTAX;
    if (powershell && (character === "," || (!word && character === "@"))) return SHELL_SYNTAX;
    word ??= { value: "", glob: [] };
    if (character === "'" || character === "\"") quote = character;
    else append(word, character, GLOB.has(character));
  }
  if (quote !== null) return SHELL_SYNTAX;
  if (word) segments.at(-1)!.push(word);
  if (segments.some((words) => words.length === 0 || words.some(({ value }) => value === "--%" || (windows && value === "")))) {
    return SHELL_SYNTAX;
  }
  return segments;
}

function permittedCharacter(character: string): boolean {
  const code = character.codePointAt(0)!;
  if (code === 0x09) return true;
  if (code < 0x20 || code === 0x7f || code === 0x60) return false;
  if (code >= 0x80 && code <= 0x9f) return false;
  if (code >= 0x2013 && code <= 0x201f) return false;
  return character === " " || !/\s/u.test(character);
}

function append(word: Word, character: string, glob: boolean): void {
  word.value += character;
  for (let index = 0; index < character.length; index += 1) word.glob.push(glob);
}

function pathProblem(word: Word, context: ReadOnlyCommandContext, providerPaths: boolean): string | null {
  const paths = context.windows ? win32 : posix;
  const separators = context.windows ? /[\\/]/u : /\//u;
  if (globReachesParent(word, separators)) return OUTSIDE;
  for (const candidate of pathCandidates(word.value)) {
    if (candidate.startsWith("~")) return OUTSIDE;
    if (context.windows && /^[A-Za-z]:(?![\\/])/u.test(candidate)) return OUTSIDE;
    if (context.windows && providerPaths && candidate.replace(/^[A-Za-z]:(?=[\\/])/u, "").includes(":")) return OUTSIDE;
    const segments = candidate.split(separators);
    if (paths.isAbsolute(candidate) || segments.includes("..")) {
      const relative = paths.relative(context.cwd, paths.resolve(context.cwd, candidate));
      if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return OUTSIDE;
    }
    if (candidate.split(/[\\/:]/u).some((segment) => ENVIRONMENT_FILE_NAME.test(segment))) return ENVIRONMENT_FILE;
  }
  return null;
}

function pathCandidates(value: string): string[] {
  const candidates = [value];
  const equals = value.indexOf("=");
  if (equals >= 0) candidates.push(value.slice(equals + 1));
  const colon = value.indexOf(":");
  if (value.startsWith("-") && colon >= 0) candidates.push(value.slice(colon + 1));
  if (/^-[^-]/u.test(value)) {
    for (let index = 2; index < value.length; index += 1) candidates.push(value.slice(index));
  }
  return candidates;
}

function globShapesOption(word: Word): boolean {
  if (word.glob[0]) return true;
  if (!/^[-+]/u.test(word.value)) return false;
  const equals = word.value.indexOf("=");
  return word.glob.slice(0, equals < 0 ? undefined : equals).includes(true);
}

function globReachesParent(word: Word, separators: RegExp): boolean {
  let start = 0;
  const characters = [...word.value];
  let offset = 0;
  for (let index = 0; index <= characters.length; index += 1) {
    const character = characters[index];
    if (character === undefined || separators.test(character)) {
      const segment = word.value.slice(start, offset);
      const globbed = word.glob.slice(start, offset).includes(true);
      if (globbed && (segment.startsWith(".") || segment.startsWith("["))) return true;
      start = offset + (character?.length ?? 0);
    }
    offset += character?.length ?? 0;
  }
  return false;
}

function refuse(reason: string): ReadOnlyCommandVerdict {
  return { allowed: false, reason };
}

function noRule(): null {
  return null;
}

function optionRule(unsafe: { short?: string; long?: readonly string[] }): ProgramRule {
  return (args) => args.some((arg) => unsafeOption(arg, unsafe)) ? UNSAFE_OPTION : null;
}

function unsafeOption(arg: string, unsafe: { short?: string; long?: readonly string[] }): boolean {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=", 1)[0]!;
    return name.length > 0 && (unsafe.long ?? []).some((option) => option.startsWith(name));
  }
  return /^-[^-]/u.test(arg) && [...(unsafe.short ?? "")].some((flag) => arg.slice(1).includes(flag));
}

function gitRule(args: readonly string[]): string | null {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index]!;
    if (option === "--no-pager" || option === "--no-optional-locks") index += 1;
    else if (option === "-C" && index + 1 < args.length) index += 2;
    else if (option === "-c" && args[index + 1] === "core.pager=cat") index += 2;
    else return UNSAFE_OPTION;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === undefined) return "git needs a read-only subcommand.";
  const unsafe = { long: GIT_UNSAFE_LONG, ...(subcommand === "grep" ? { short: "O" } : {}) };
  if (rest.some((arg) => unsafeOption(arg, unsafe))) return UNSAFE_OPTION;
  const refused = `git ${/^[a-z-]{1,32}$/u.test(subcommand) ? subcommand : "with this subcommand"} is not a read-only command watchers can run.`;
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return null;
  if (subcommand === "branch") return gitListing(rest, GIT_BRANCH_FLAGS, false) ? null : refused;
  if (subcommand === "tag") return gitListing(rest, GIT_TAG_FLAGS, true) ? null : refused;
  if (subcommand === "cat-file") {
    return rest.length === 2 && GIT_CAT_FILE_MODES.has(rest[0]!) && !rest[1]!.startsWith("-") ? null : refused;
  }
  if (subcommand === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ? null : refused;
  if (subcommand === "stash") return rest[0] === "list" ? null : refused;
  if (subcommand === "worktree") {
    return rest[0] === "list" && rest.slice(1).every((arg) => GIT_WORKTREE_LIST_FLAGS.has(arg)) ? null : refused;
  }
  return refused;
}

function gitListing(args: readonly string[], flags: ReadonlySet<string>, listRequired: boolean): boolean {
  const listing = args.includes("--list") || args.includes("-l");
  if (listRequired && !listing) return false;
  return args.every((arg) => {
    if (!arg.startsWith("-")) return listing;
    return flags.has(arg)
      || GIT_REF_FILTERS.some((prefix) => arg.startsWith(prefix))
      || (flags.has("-n") && /^-n\d+$/u.test(arg));
  });
}

function tailRule(args: readonly string[]): string | null {
  const follows = args.some((arg) => TAIL_OBSOLETE_FOLLOW.test(arg) || unsafeOption(arg, { short: "fF", long: ["follow"] }));
  return follows ? UNSAFE_OPTION : null;
}

function findRule(args: readonly string[]): string | null {
  return args.some((arg) => FIND_UNSAFE.has(arg) || arg.startsWith("-fprint")) ? UNSAFE_OPTION : null;
}

function uniqRule(args: readonly string[], globbed: readonly boolean[]): string | null {
  if (globbed.includes(true)) return UNIQ_GLOB;
  let positionals = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (UNIQ_VALUE_OPTIONS.has(arg)) index += 1;
    else if (arg === "-" || !arg.startsWith("-")) positionals += 1;
  }
  return positionals > 1 ? UNSAFE_OPTION : null;
}

function jqRule(args: readonly string[]): string | null {
  return args.some((arg) => /env/iu.test(arg)) ? "jq cannot read the environment in a watcher." : null;
}
