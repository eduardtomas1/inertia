import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL =
  "Inertia blocked this command because it could reveal the API key for this backend. Do not read or print ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or the whole environment.";

const CREDENTIAL_VARIABLE = /ANTHROPIC_(?:API_KEY|AUTH_TOKEN)/iu;
const PROCESS_ENVIRONMENT_FILE = /\/proc\/[^\s/]+\/environ\b/iu;
const POWERSHELL_ENVIRONMENT =
  /(?:^|[\s;|&(])(?:get-childitem|gci|dir|ls|get-item|gi)\s+(?:-(?:literal)?path\s+)?["']?env:[\\/]?\*?["']?(?=$|[\s;|&)])|\[(?:system\.)?environment\]::getenvironmentvariables/iu;
const SEGMENT_SEPARATOR = /\|\||&&|\$\(|[;|&\n\r(){}`]/u;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PREFIX_COMMANDS: ReadonlySet<string> = new Set([
  "builtin",
  "command",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
]);
const NESTED_SHELLS: ReadonlySet<string> = new Set([
  "bash",
  "cmd",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const NESTED_SHELL_FLAGS: ReadonlySet<string> = new Set(["-c", "/c", "/k", "-command", "-lc"]);
const ENV_OPTIONS_WITH_VALUES: ReadonlySet<string> = new Set(["-u", "--unset", "-C", "--chdir"]);
const MAX_NESTED_SHELL_DEPTH = 4;
export const CLAUDE_CREDENTIAL_COMMAND_HOOK_MATCHER = "Bash|PowerShell";

export const claudeCredentialCommandHook: HookCallback = async (input) => {
  if (
    input.hook_event_name !== "PreToolUse"
    || (input.tool_name !== "Bash" && input.tool_name !== "PowerShell")
  ) return {};
  const toolInput = input.tool_input;
  const command = typeof toolInput === "object" && toolInput !== null
    ? (toolInput as Record<string, unknown>).command
    : undefined;
  if (typeof command !== "string" || !claudeCommandExposesLaunchCredentials(command)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL,
    },
  };
};

export function claudeCredentialCommandHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{
      matcher: CLAUDE_CREDENTIAL_COMMAND_HOOK_MATCHER,
      hooks: [claudeCredentialCommandHook],
    }],
  };
}

export function claudeCommandExposesLaunchCredentials(command: string, depth = 0): boolean {
  if (
    CREDENTIAL_VARIABLE.test(command)
    || PROCESS_ENVIRONMENT_FILE.test(command)
    || POWERSHELL_ENVIRONMENT.test(command)
  ) return true;
  return command.split(SEGMENT_SEPARATOR).some((segment) => segmentDumpsEnvironment(segment, depth));
}

function segmentDumpsEnvironment(segment: string, depth: number): boolean {
  const words = segment.trim().split(/\s+/u)
    .map((word) => word.replace(/^["']+|["']+$/gu, ""))
    .filter((word) => word.length > 0);
  let start = 0;
  while (
    start < words.length
    && (ENVIRONMENT_ASSIGNMENT.test(words[start]!) || PREFIX_COMMANDS.has(words[start]!.toLowerCase()))
  ) start += 1;
  const [name, ...args] = words.slice(start);
  if (!name) return false;
  const program = name.split(/[\\/]/u).at(-1)!.toLowerCase().replace(/\.exe$/u, "");
  const operands = args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("+"));
  if (NESTED_SHELLS.has(program)) {
    const flag = args.findIndex((arg) => NESTED_SHELL_FLAGS.has(arg.toLowerCase()));
    return flag >= 0 && depth < MAX_NESTED_SHELL_DEPTH
      && claudeCommandExposesLaunchCredentials(args.slice(flag + 1).join(" "), depth + 1);
  }
  switch (program) {
    case "env":
      return envPrintsEnvironment(args);
    case "printenv":
      return operands.length === 0;
    case "set":
      return args.length === 0
        || (args.length === 1 && /^[A-Za-z_]/u.test(args[0]!) && !args[0]!.includes("="));
    case "export":
    case "declare":
    case "typeset":
      return operands.length === 0;
    default:
      return false;
  }
}

function envPrintsEnvironment(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (ENV_OPTIONS_WITH_VALUES.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-") || ENVIRONMENT_ASSIGNMENT.test(arg)) continue;
    return false;
  }
  return true;
}
