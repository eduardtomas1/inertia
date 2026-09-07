import type { AuthMethodAgent, AuthMethodTerminal } from "@agentclientprotocol/sdk";

// Kimi's published ACP login-only contract: same configured invocation, plus
// --login. Only its existing data-root override is replayable; descriptors may
// not change loaders, host controls, credentials, PATH or profile identity.
const KIMI_TERMINAL_LOGIN_ARGUMENTS = ["--login"] as const;
const KIMI_TERMINAL_LOGIN_ENVIRONMENT = "KIMI_CODE_HOME";
const MAX_AUTH_METHODS = 16;
const MAX_AUTH_ID_CHARS = 256;
const MAX_AUTH_NAME_CHARS = 512;
const MAX_AUTH_DESCRIPTION_CHARS = 2_048;
const MAX_AUTH_ENVIRONMENT_BYTES = 4_096;
const TERMINAL_FIELDS = new Set(["id", "name", "description", "type", "args", "env", "_meta"]);

export type ValidatedAcpTerminalAuthMethod = AuthMethodTerminal & {
  type: "terminal";
  args: string[];
  env: Record<string, string>;
};
export type ValidatedAcpAgentAuthMethod = AuthMethodAgent & { type?: never };

function invalidDescriptor(): never {
  // Never include provider-authored values: args/env can contain secrets.
  throw new Error("Kimi ACP returned an unsupported or invalid terminal authentication descriptor.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidDescriptor();
  return value as Record<string, unknown>;
}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars
    || /[\u0000-\u001f\u007f]/u.test(value)) invalidDescriptor();
  return value;
}

function terminalEnvironment(value: unknown, base: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  if (value === undefined) return {};
  const environment = record(value);
  const keys = Object.keys(environment);
  if (keys.length === 0) return {};
  if (keys.length !== 1 || keys[0] !== KIMI_TERMINAL_LOGIN_ENVIRONMENT) invalidDescriptor();
  const override = text(environment[KIMI_TERMINAL_LOGIN_ENVIRONMENT], MAX_AUTH_ENVIRONMENT_BYTES);
  if (Buffer.byteLength(override, "utf8") > MAX_AUTH_ENVIRONMENT_BYTES) invalidDescriptor();
  const baseKeys = Object.keys(base).filter(key =>
    (platform === "win32" ? key.toUpperCase() : key) === KIMI_TERMINAL_LOGIN_ENVIRONMENT);
  if (baseKeys.length !== 1 || base[baseKeys[0]!] !== override) invalidDescriptor();
  // Preserve the base key's casing to avoid duplicate environment identities
  // when Windows treats environment names case-insensitively.
  return { [baseKeys[0]!]: override };
}

/** Shared by Kimi turn initialization and the privileged, user-selected login owner. */
export function selectKimiAcpAuthMethod(
  methods: unknown,
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ValidatedAcpAgentAuthMethod | ValidatedAcpTerminalAuthMethod | undefined {
  if (methods === undefined || methods === null) return undefined;
  if (!Array.isArray(methods) || methods.length > MAX_AUTH_METHODS) invalidDescriptor();
  const ids = new Set<string>();
  let selected: ValidatedAcpAgentAuthMethod | ValidatedAcpTerminalAuthMethod | undefined;
  for (const value of methods) {
    const method = record(value);
    const id = text(method.id, MAX_AUTH_ID_CHARS);
    const name = text(method.name, MAX_AUTH_NAME_CHARS);
    const description = method.description === undefined || method.description === null
      ? undefined : text(method.description, MAX_AUTH_DESCRIPTION_CHARS);
    if (ids.has(id)) invalidDescriptor();
    ids.add(id);
    if (!("type" in method)) {
      if (id === "login") selected = { id, name, ...(description ? { description } : {}) };
      continue;
    }
    if (method.type !== "terminal" || id !== "login"
      || Object.keys(method).some(key => !TERMINAL_FIELDS.has(key))
      || !Array.isArray(method.args)
      || method.args.length !== KIMI_TERMINAL_LOGIN_ARGUMENTS.length
      || method.args.some((argument, index) => argument !== KIMI_TERMINAL_LOGIN_ARGUMENTS[index])) {
      invalidDescriptor();
    }
    selected = {
      id, name, ...(description ? { description } : {}), type: "terminal",
      args: [...KIMI_TERMINAL_LOGIN_ARGUMENTS],
      env: terminalEnvironment(method.env, baseEnvironment, platform),
    };
  }
  return selected;
}
