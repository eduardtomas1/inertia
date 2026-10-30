import { isAbsolute, join, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";

import { claudeEnvironmentValue } from "./claude-config-files";

const RESERVED = new Set([
  "--mode", "--session", "--session-id", "--session-dir", "--no-session", "--continue", "-c", "--resume", "-r",
  "--fork", "--print", "-p", "--help", "-h", "--version", "-v", "--export", "--list-models", "--api-key",
  "--tools", "-t", "--exclude-tools", "-xt", "--no-tools", "-nt", "--no-builtin-tools", "-nbt",
]);
const VALUES = new Set(["--provider", "--model", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--name", "-n"]);
const SWITCHES = new Set(["--offline", "--verbose", "--no-extensions", "-ne", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-context-files", "-nc", "--no-themes"]);

export interface PiLaunchConfiguration {
  executable: string;
  args: string[];
  sessionDirectory: string;
}

export function piNativeTools(platform: NodeJS.Platform = process.platform): string[] {
  return ["read", "bash", ...(platform === "win32" ? ["powershell"] : []), "edit", "write", "grep", "find", "ls"];
}

/** Configuration stays in the privileged environment; credentials never enter argv. */
export function piLaunchConfiguration(environment: NodeJS.ProcessEnv, executable?: string): PiLaunchConfiguration {
  const configured = claudeEnvironmentValue(environment, "INERTIA_PI_ARGS");
  let input: unknown = [];
  if (configured) {
    if (configured.length > 32 * 1024) throw new Error("Pi launch arguments exceed their size limit.");
    try { input = JSON.parse(configured); } catch { throw new Error("INERTIA_PI_ARGS must be a JSON string array."); }
  }
  if (!Array.isArray(input) || input.length > 64 || input.some((arg) => typeof arg !== "string" || arg.length > 4096 || /[\u0000\r\n]/u.test(arg))) {
    throw new Error("Pi launch arguments are invalid.");
  }
  const args: string[] = [];
  let hasProvider = false; let hasModel = false;
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as string;
    const equal = raw.indexOf("=");
    const name = equal >= 0 ? raw.slice(0, equal) : raw;
    if (RESERVED.has(name) || /(?:token|secret|password|api.?key|bearer|authorization)/iu.test(name)
      || raw === "--" || !name.startsWith("-")) throw new Error("A Pi launch argument overrides Inertia's owned protocol, tools, or credentials.");
    if (VALUES.has(name)) {
      const value = equal >= 0 ? raw.slice(equal + 1) : input[++index] as string | undefined;
      if (!value || value.startsWith("-") || value.startsWith("@")) throw new Error("A Pi launch argument requires a literal value.");
      if (["--extension", "-e", "--skill", "--prompt-template"].includes(name) && !isAbsolute(value)) throw new Error("Explicit Pi resources require absolute paths.");
      hasProvider ||= name === "--provider"; hasModel ||= name === "--model";
      args.push(name, value);
    } else if (SWITCHES.has(raw)) args.push(raw);
    else if (/^--[a-z][a-z0-9-]{0,80}=.+$/u.test(raw)) args.push(raw);
    else throw new Error("Unsupported Pi launch argument; extension flags require --name=value.");
  }
  if (hasProvider && !hasModel) throw new Error("Pi requires --model when --provider is configured.");
  const configuredHome = claudeEnvironmentValue(environment, "PI_CODING_AGENT_DIR");
  const home = claudeEnvironmentValue(environment, "HOME") || claudeEnvironmentValue(environment, "USERPROFILE") || homedir();
  const agentHome = configuredHome || join(home, ".pi", "agent");
  if (!isAbsolute(agentHome) || agentHome.includes("\0")) throw new Error("Pi's configuration directory must be absolute.");
  const requestedExecutable = executable || claudeEnvironmentValue(environment, "INERTIA_PI_EXECUTABLE")?.trim() || "pi";
  if (!requestedExecutable || /[\u0000\r\n]/u.test(requestedExecutable)) throw new Error("Pi executable configuration is invalid.");
  return { executable: requestedExecutable, args, sessionDirectory: join(agentHome, "inertia-sessions") };
}

export function piRpcArguments(config: PiLaunchConfiguration, options: {
  ephemeral?: boolean; sessionFile?: string; newSessionId?: string; forkFile?: string; extensionFile?: string; tools?: readonly string[];
} = {}): string[] {
  if (options.sessionFile && options.forkFile) throw new Error("Pi cannot resume and fork in the same launch.");
  return [
    "--mode", "rpc", ...config.args,
    // Only explicitly selected extensions can execute in the provider process.
    "--no-extensions", "--no-context-files",
    ...(options.ephemeral ? ["--no-session"] : ["--session-dir", config.sessionDirectory]),
    ...(options.sessionFile ? ["--session", options.sessionFile] : []),
    ...(options.newSessionId ? ["--session-id", options.newSessionId] : []),
    ...(options.forkFile ? ["--fork", options.forkFile] : []),
    ...(options.extensionFile ? ["--extension", options.extensionFile] : []),
    ...(options.tools?.length ? ["--tools", options.tools.join(",")] : ["--no-tools"]),
  ];
}

export async function validatePiLaunchResources(config: PiLaunchConfiguration): Promise<void> {
  for (let index = 0; index < config.args.length; index += 1) {
    if (!["--extension", "-e", "--skill", "--prompt-template"].includes(config.args[index]!)) continue;
    const path = config.args[++index]!;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.size > 4 * 1024 * 1024
      || await realpath(path) !== resolve(path)) throw new Error("Explicit Pi resources must be bounded canonical files or directories.");
  }
}
