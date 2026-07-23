import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { executableCandidates, providerEnvironment, type ProviderEnvironment } from "../environment";
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
}

interface ProviderDiscoveryDependencies {
  executableCandidates?: typeof executableCandidates;
  probeProcess?: typeof probeProcess;
}

async function probeProcess(
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
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
      resolveProbe({ exitCode, output: output.toString(), started, timedOut });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      const invocation = providerProcessInvocation(executable, args, environment.env);
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: environment.env,
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
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* The probe may already have exited. */ }
      finish(null);
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

  if (/not (?:logged|signed) in|loggedin["']?\s*:\s*false|authentication required|no credentials|please (?:log|sign) in/iu.test(lower)) {
    return providerId === "opencode" ? "unknown" : "unauthenticated";
  }
  if (/logged in|signed in|authenticated|loggedin["']?\s*:\s*true/iu.test(lower)) return "authenticated";
  if (providerId === "opencode" && probe.exitCode === 0 && normalized.length > 0) return "configured";
  if (probe.exitCode && probe.exitCode !== 0) return providerId === "opencode" ? "unknown" : "unauthenticated";
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
  const runProbe = dependencies.probeProcess ?? probeProcess;
  const provider = PROVIDER_INFO[providerId];
  const command = options.command?.trim() || provider.command;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS, 10_000));
  const cwd = options.cwd ?? process.cwd();
  const environment = await providerEnvironment(options.refreshEnvironment === true);
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
    const cursorWithoutAcp = providerId === "cursor" && versionProbes.some(
      ({ probe }) => probe.started && !probe.timedOut && probe.exitCode === 0,
    );
    return {
      provider,
      available: cursorWithoutAcp,
      installState: cursorWithoutAcp ? "installed" : "error",
      authState: "unknown",
      canRun: false,
      statusMessage: cursorWithoutAcp
        ? "Cursor CLI found, but ACP is unavailable"
        : providerId === "codex" ? "Codex CLI was found but failed to start" : statusMessage("error", "unknown"),
    };
  }

  const authProbe = await runProbe(selected.executable, providerAuthStatusArgs(providerId), environment, cwd, timeoutMs);
  const authState = authStateFromProbe(providerId, authProbe);
  const authenticated = authState === "authenticated" || authState === "configured";
  const appServerReady = selected.appServerReady;
  const canRun = authenticated && appServerReady;
  return {
    provider,
    available: true,
    executable: selected.executable,
    ...(selected.version ? { version: selected.version } : {}),
    installState: "installed",
    authState,
    canRun,
    statusMessage: providerId === "codex" && !appServerReady
      ? "Codex App Server is unsupported; update the selected CLI"
      : statusMessage("installed", authState),
  };
}

export async function detectProviders(
  options: Partial<Record<ProviderId, ProviderDetectionOptions>> = {},
): Promise<ProviderDetection[]> {
  return await Promise.all(PROVIDER_IDS.map((id) => detectProvider(id, options[id])));
}
