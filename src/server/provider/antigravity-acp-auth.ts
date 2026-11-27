import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AuthMethodAgent, AuthMethodTerminal } from "@agentclientprotocol/sdk/unstable";

import { runtimeOwnedProcessInvocation, spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
import { INERTIA_VERSION } from "../../shared/version";
import { createOwnedProcessTreeTermination, type ProcessTreeTerminator } from "../process-lifecycle";
import { validateAntigravityInitialize } from "./antigravity-acp-projection";
import { BoundedAntigravityJsonLineTransform } from "./antigravity-acp-support";
import { ProviderRunEventBudget } from "./io";
import { providerProcessInvocation } from "./process";

const ANTIGRAVITY_TERMINAL_LOGIN_ID = "terminal-login";
const ANTIGRAVITY_TERMINAL_LOGIN_ARGS = ["--login"] as const;
const ANTIGRAVITY_AGENT_AUTH_IDS = new Set([
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
]);
const TERMINAL_FIELDS = new Set(["id", "name", "description", "type", "args", "env", "_meta"]);
const MAX_AUTH_METHODS = 16;
const MAX_AUTH_ID_CHARS = 256;
const MAX_AUTH_NAME_CHARS = 512;
const MAX_AUTH_DESCRIPTION_CHARS = 2_048;

const FRAME_BYTES = 64 * 1024;
const TOTAL_BYTES = 512 * 1024;
const MAX_EVENTS = 64;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ValidatedAntigravityTerminalAuthMethod = AuthMethodTerminal & {
  type: "terminal";
  args: string[];
  env: Record<string, string>;
};
export type ValidatedAntigravityAgentAuthMethod = AuthMethodAgent & { type?: never };
export type ValidatedAntigravityAuthMethod =
  | ValidatedAntigravityAgentAuthMethod
  | ValidatedAntigravityTerminalAuthMethod;

export interface AntigravityAuthenticationProbeDependencies {
  timeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
}

function invalidDescriptor(): never {
  // Never include provider-authored values: args/env can contain secrets.
  throw new Error("Antigravity ACP returned an unsupported or invalid terminal authentication descriptor.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidDescriptor();
  return value as Record<string, unknown>;
}

function text(value: unknown, maxChars: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxChars
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalidDescriptor();
  }
  return value;
}

function terminalEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const environment = record(value);
  if (Object.keys(environment).length !== 0) invalidDescriptor();
  return {};
}

function hasGeminiApiKey(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.GEMINI_API_KEY?.trim());
}

function hasAdcAuthEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.AGY_ADC_AUTH?.trim().toLowerCase();
  return value === "true" || value === "1";
}

function parseValidatedAuthMethods(
  methods: unknown,
): {
  terminal?: ValidatedAntigravityTerminalAuthMethod;
  agents: Map<string, ValidatedAntigravityAgentAuthMethod>;
} {
  if (methods === undefined || methods === null) return { agents: new Map() };
  if (!Array.isArray(methods) || methods.length > MAX_AUTH_METHODS) invalidDescriptor();
  const ids = new Set<string>();
  const agents = new Map<string, ValidatedAntigravityAgentAuthMethod>();
  let terminal: ValidatedAntigravityTerminalAuthMethod | undefined;
  for (const value of methods) {
    const method = record(value);
    const id = text(method.id, MAX_AUTH_ID_CHARS);
    const name = text(method.name, MAX_AUTH_NAME_CHARS);
    const description = method.description === undefined || method.description === null
      ? undefined
      : text(method.description, MAX_AUTH_DESCRIPTION_CHARS);
    if (ids.has(id)) invalidDescriptor();
    ids.add(id);
    if (!("type" in method) || method.type === undefined) {
      if (ANTIGRAVITY_AGENT_AUTH_IDS.has(id)) {
        agents.set(id, { id, name, ...(description ? { description } : {}) });
      }
      continue;
    }
    if (
      method.type !== "terminal"
      || id !== ANTIGRAVITY_TERMINAL_LOGIN_ID
      || Object.keys(method).some((key) => !TERMINAL_FIELDS.has(key))
      || !Array.isArray(method.args)
      || method.args.length !== ANTIGRAVITY_TERMINAL_LOGIN_ARGS.length
      || method.args.some((argument, index) => argument !== ANTIGRAVITY_TERMINAL_LOGIN_ARGS[index])
    ) {
      invalidDescriptor();
    }
    terminal = {
      id,
      name,
      ...(description ? { description } : {}),
      type: "terminal",
      args: [...ANTIGRAVITY_TERMINAL_LOGIN_ARGS],
      env: terminalEnvironment(method.env),
    };
  }
  return { terminal, agents };
}

/**
 * Strictly validates all advertised Antigravity ACP auth methods.
 * Prefers the allowlisted `terminal-login` descriptor when present (for explicit
 * Connect terminal login), otherwise selects a validated agent auth method.
 */
export function selectAntigravityAcpAuthMethod(
  methods: unknown,
  baseEnvironment: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform = process.platform,
): ValidatedAntigravityAuthMethod | undefined {
  const parsed = parseValidatedAuthMethods(methods);
  if (parsed.terminal) return parsed.terminal;
  if (hasGeminiApiKey(baseEnvironment) && parsed.agents.has("gemini-api-key")) {
    return parsed.agents.get("gemini-api-key");
  }
  if (hasAdcAuthEnabled(baseEnvironment) && parsed.agents.has("agent-platform")) {
    return parsed.agents.get("agent-platform");
  }
  return parsed.agents.get("oauth-personal")
    ?? parsed.agents.get("oauth-business")
    ?? parsed.agents.get("gemini-api-key")
    ?? parsed.agents.get("agent-platform");
}

/**
 * Validates wire auth metadata during a turn and selects an explicit ACP
 * `authenticate` method ONLY for non-interactive credentials (`GEMINI_API_KEY`
 * or `AGY_ADC_AUTH`). Cached OAuth logins skip `authenticate` so a turn never
 * triggers an unexpected browser popup.
 */
export function selectAntigravityTurnAuthMethod(
  methods: unknown,
  environment: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform = process.platform,
): "gemini-api-key" | "agent-platform" | undefined {
  const parsed = parseValidatedAuthMethods(methods);
  if (hasGeminiApiKey(environment) && parsed.agents.has("gemini-api-key")) {
    return "gemini-api-key";
  }
  if (hasAdcAuthEnabled(environment) && parsed.agents.has("agent-platform")) {
    return "agent-platform";
  }
  return undefined;
}

/** Discovers login metadata only. The caller owns any subsequent PTY launch. */
export async function probeAntigravityAuthentication(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  options: AntigravityAuthenticationProbeDependencies = {},
): Promise<ValidatedAntigravityAuthMethod | undefined> {
  const cancelled = (): Error => new Error("Antigravity authentication discovery was cancelled.");
  if (signal?.aborted) throw cancelled();
  const invocation = providerProcessInvocation(executable, ["acp", "--stdio"], environment);
  const owned = runtimeOwnedProcessInvocation(invocation.command, invocation.args);
  const child = spawnRuntimeOwnedProcess(() => spawn(owned.command, owned.args, {
    cwd,
    env: environment,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  const terminate = createOwnedProcessTreeTermination(
    child,
    "Antigravity authentication discovery process tree",
    options.terminateProcessTree,
  );
  const wire = new BoundedAntigravityJsonLineTransform(
    FRAME_BYTES,
    new ProviderRunEventBudget(
      "Antigravity authentication discovery",
      FRAME_BYTES,
      MAX_EVENTS,
      TOTAL_BYTES,
      { maxRunEvents: MAX_EVENTS, maxRunBytes: TOTAL_BYTES },
    ),
  );
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { fail = reject; });
  const onAbort = (): void => fail(cancelled());
  const onError = (): void => fail(new Error("Antigravity authentication discovery process failed."));
  const onClose = (): void => fail(
    new Error("Antigravity authentication discovery exited before initialization completed."),
  );
  const onWireError = (): void => fail(
    new Error("Antigravity authentication discovery returned malformed or excessive protocol data."),
  );
  let stderrBytes = 0;
  const onStderr = (chunk: Buffer): void => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > TOTAL_BYTES) {
      fail(new Error("Antigravity authentication discovery exceeded its stderr limit."));
    }
  };
  child.once("error", onError);
  child.once("close", onClose);
  child.stdin.on("error", onError);
  child.stdout.on("error", onError);
  child.stderr.on("error", onError);
  child.stderr.on("data", onStderr);
  wire.once("error", onWireError);
  child.stdout.pipe(wire);
  signal?.addEventListener("abort", onAbort, { once: true });
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(requestedTimeout, 20_000))
    : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(
    () => fail(new Error("Antigravity authentication discovery timed out.")),
    timeoutMs,
  );
  timer.unref();
  let selected: ValidatedAntigravityAuthMethod | undefined;
  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(wire) as ReadableStream<Uint8Array>,
    );
    const operation = acp.client({ name: "inertia" }).connectWith(stream, async (context) => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: "inertia", version: INERTIA_VERSION },
        clientCapabilities: { auth: { terminal: true } },
      });
      validateAntigravityInitialize(initialized);
      return selectAntigravityAcpAuthMethod(initialized.authMethods, environment);
    }).catch(() => {
      // JSON/schema/RPC failures can quote provider-authored fields. Login
      // discovery must not forward those values into notifications or logs.
      throw new Error("Antigravity authentication discovery returned invalid initialization data.");
    });
    selected = await Promise.race([operation, failed]);
  } finally {
    clearTimeout(timer);
    // The exact tree must be retired even for malformed frames, cancellation,
    // or a valid descriptor. Unconfirmed cleanup overrides any usable result.
    try {
      await terminate(true);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      child.stdout.unpipe(wire);
      wire.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
  // Cancellation while awaiting the cleanup barrier cannot authorize login.
  if (signal?.aborted) throw cancelled();
  return selected;
}
