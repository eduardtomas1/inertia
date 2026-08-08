import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  executableCandidates,
  providerChildEnvironment,
  providerEnvironment,
  type ProviderEnvironment,
} from "../environment";
import {
  requireProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { providerAuthStatusArgs } from "./auth";
import { PROVIDER_INFO } from "./catalog";
import {
  PROVIDER_IDS,
  type ProviderAuthState,
  type ProviderDetection,
  type ProviderDetectionOptions,
  type ProviderId,
  type ProviderInstallState,
} from "./contracts";
import { CappedProviderBuffer } from "./io";
import { providerProcessInvocation } from "./process";
import { windowsCodexExecutableCandidates } from "./windows-codex";

const DEFAULT_DETECTION_TIMEOUT_MS = 2_500;

function versionFromOutput(output: string): string | undefined {
  return output.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0];
}

interface ProbeResult {
  exitCode: number | null;
  output: string;
  started: boolean;
  timedOut: boolean;
  cleanupConfirmed?: boolean | null;
}

type ProviderProbeProcess = (
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
) => Promise<ProbeResult>;

interface ProviderDiscoveryDependencies {
  executableCandidates?: typeof executableCandidates;
  probeProcess?: ProviderProbeProcess;
  terminateProcessTree?: ProcessTreeTerminator;
}

async function probeProcess(
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
  terminateProcessTree: ProcessTreeTerminator = terminateProcessTreeAndWait,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolveProbe) => {
    const output = new CappedProviderBuffer(16 * 1024);
    let settled = false;
    let started = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProbe({
        exitCode,
        output: output.toString(),
        started,
        timedOut,
        cleanupConfirmed: null,
      });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      const invocation = providerProcessInvocation(executable, args, environment.env);
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: environment.env,
        detached: process.platform !== "win32",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    child.once("spawn", () => { started = true; });
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    child.stdin.end();

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      settled = true;
      void requireProcessTreeTermination(
        terminateProcessTree,
        child,
        true,
        "Provider discovery process tree",
      ).then(
        () => resolveProbe({
          exitCode: null,
          output: output.toString(),
          started,
          timedOut,
          cleanupConfirmed: true,
        }),
        () => resolveProbe({
          exitCode: null,
          output: output.toString(),
          started,
          timedOut,
          cleanupConfirmed: false,
        }),
      );
    }, timeoutMs);
    timer.unref();
  });
}

function versionParts(version: string | undefined): number[] {
  return (version?.match(/\d+(?:\.\d+){1,2}/u)?.[0] ?? "0.0.0").split(".").map((part) => Number(part));
}

function compareVersions(left: string | undefined, right: string | undefined): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function nativeExecutablePreference(executable: string): number {
  return /\.exe$/iu.test(executable) ? 1 : 0;
}

function authStateFromProbe(providerId: ProviderId, probe: ProbeResult): ProviderAuthState {
  if (!probe.started || probe.timedOut) return "unknown";
  const normalized = probe.output.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  const lower = normalized.toLowerCase();

  if (providerId === "claude") {
    try {
      const status = JSON.parse(normalized) as { loggedIn?: unknown };
      if (status.loggedIn === true) return "authenticated";
      if (status.loggedIn === false) return "unauthenticated";
    } catch { /* Older Claude releases may return text. */ }
  }

  if (providerId === "opencode") {
    if (probe.exitCode !== 0) return "unknown";
    const configurationCounts = [...lower.matchAll(/\b(\d+)\s+(?:credentials?|environment variables?)\b/gu)]
      .map((match) => Number(match[1]));
    if (configurationCounts.some((count) => count > 0)) return "configured";
    // Current OpenCode exits successfully even when `auth list` reports zero
    // usable credentials. Unknown output must not be promoted to runnable.
    return "unknown";
  }

  if (/not (?:logged|signed) in|loggedin["']?\s*:\s*false|authentication required|no credentials|please (?:log|sign) in/iu.test(lower)) {
    return "unauthenticated";
  }
  if (/logged in|signed in|authenticated|loggedin["']?\s*:\s*true/iu.test(lower)) return "authenticated";
  if (probe.exitCode && probe.exitCode !== 0) return "unauthenticated";
  return "unknown";
}

function statusMessage(installState: ProviderInstallState, authState: ProviderAuthState): string {
  if (installState === "not-installed") return "CLI not found";
  if (installState === "error") return "CLI did not respond";
  if (authState === "authenticated") return "Connected";
  if (authState === "configured") return "Configured";
  if (authState === "unauthenticated") return "Sign in required";
  if (authState === "error") return "Connection check failed";
  return "Installed; connection not confirmed";
}

export async function detectProvider(
  providerId: ProviderId,
  options: ProviderDetectionOptions = {},
  dependencies: ProviderDiscoveryDependencies = {},
): Promise<ProviderDetection> {
  const resolveCandidates = dependencies.executableCandidates ?? executableCandidates;
  const terminateProcessTree = dependencies.terminateProcessTree
    ?? terminateProcessTreeAndWait;
  const runProbe: ProviderProbeProcess = dependencies.probeProcess
    ?? (async (...args) => await probeProcess(...args, terminateProcessTree));
  const provider = PROVIDER_INFO[providerId];
  const command = options.command?.trim() || provider.command;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS, 10_000));
  const cwd = options.cwd ?? process.cwd();
  const discoveredEnvironment = await providerEnvironment(
    options.refreshEnvironment === true,
  );
  const environment: ProviderEnvironment = {
    env: providerChildEnvironment(providerId, discoveredEnvironment.env),
    pathEntries: discoveredEnvironment.pathEntries,
  };
  const candidateCommands = providerId === "cursor" && command === PROVIDER_INFO.cursor.command
    ? [command, "cursor-agent"]
    : [command];
  const candidates = providerId === "codex"
    && process.platform === "win32"
    && command.toLocaleLowerCase("en-US") === PROVIDER_INFO.codex.command
    && dependencies.executableCandidates === undefined
    ? await windowsCodexExecutableCandidates(environment, cwd)
    : [...new Set((await Promise.all(candidateCommands.map(
      async (candidate) => await resolveCandidates(candidate, environment, cwd),
    ))).flat())];
  if (candidates.length === 0) {
    return {
      provider,
      available: false,
      installState: "not-installed",
      authState: "unknown",
      canRun: false,
      statusMessage: providerId === "codex" ? "Codex CLI not found" : statusMessage("not-installed", "unknown"),
    };
  }

  const versionProbes = await Promise.all(candidates.map(async (executable) => {
    const probe = await runProbe(executable, ["--version"], environment, cwd, timeoutMs);
    const acpProbe = providerId === "cursor" && probe.started && !probe.timedOut && probe.exitCode === 0
      ? await runProbe(executable, ["acp", "--help"], environment, cwd, timeoutMs)
      : undefined;
    const acpReady = !acpProbe || (
      acpProbe.started
      && !acpProbe.timedOut
      && acpProbe.exitCode === 0
      && /(?:agent client protocol|\bacp\b|cursor)/iu.test(acpProbe.output)
    );
    const appServerProbe = providerId === "codex" && probe.started && !probe.timedOut && probe.exitCode === 0
      ? await runProbe(executable, ["app-server", "--help"], environment, cwd, timeoutMs)
      : undefined;
    const appServerReady = !appServerProbe || (
      appServerProbe.started
      && !appServerProbe.timedOut
      && appServerProbe.exitCode === 0
      && /(?:codex\s+app-server|run the app server|\bapp-server\b)/iu.test(appServerProbe.output)
    );
    return { executable, probe, version: versionFromOutput(probe.output), acpReady, appServerReady };
  }));
  const working = versionProbes
    .filter(({ probe, acpReady }) => probe.started && !probe.timedOut && probe.exitCode === 0 && acpReady)
    .sort((left, right) =>
      compareVersions(right.version, left.version)
      || nativeExecutablePreference(right.executable) - nativeExecutablePreference(left.executable));
  const selected = providerId === "codex"
    ? working.find(({ appServerReady }) => appServerReady) ?? working[0]
    : working[0];
  if (!selected) {
    const cleanupUnconfirmed = versionProbes.some(
      ({ probe }) => probe.cleanupConfirmed === false,
    );
    const cursorWithoutAcp = providerId === "cursor" && versionProbes.some(
      ({ probe }) => probe.started && !probe.timedOut && probe.exitCode === 0,
    );
    return {
      provider,
      available: cursorWithoutAcp,
      installState: cursorWithoutAcp ? "installed" : "error",
      authState: "unknown",
      canRun: false,
      statusMessage: cleanupUnconfirmed
        ? `${provider.name} probe timed out, and its process tree could not be confirmed stopped`
        : cursorWithoutAcp
        ? "Cursor CLI found, but ACP is unavailable"
        : providerId === "codex" ? "Codex CLI was found but failed to start" : statusMessage("error", "unknown"),
    };
  }

  const authProbe = await runProbe(selected.executable, providerAuthStatusArgs(providerId), environment, cwd, timeoutMs);
  const authState = authStateFromProbe(providerId, authProbe);
  const authenticated = authState === "authenticated" || authState === "configured";
  const appServerReady = selected.appServerReady;
  const cleanupUnconfirmed = authProbe.cleanupConfirmed === false;
  const canRun = authenticated
    && appServerReady
    && !cleanupUnconfirmed;
  return {
    provider,
    available: true,
    executable: selected.executable,
    ...(selected.version ? { version: selected.version } : {}),
    installState: "installed",
    authState,
    canRun,
    statusMessage: cleanupUnconfirmed
      ? `${provider.name} connection probe timed out, and its process tree could not be confirmed stopped`
      : providerId === "codex" && !appServerReady
      ? "Codex App Server is unsupported; update the selected CLI"
      : statusMessage("installed", authState),
  };
}

export async function detectProviders(
  options: Partial<Record<ProviderId, ProviderDetectionOptions>> = {},
): Promise<ProviderDetection[]> {
  return await Promise.all(PROVIDER_IDS.map((id) => detectProvider(id, options[id])));
}
