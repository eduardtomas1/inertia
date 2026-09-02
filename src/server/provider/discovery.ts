import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import {
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";

import {
  credentialFreeProviderEnvironment,
  environmentValue,
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
import { cursorAgentCommandArgs } from "./cursor-command";

const DEFAULT_DETECTION_TIMEOUT_MS = 2_500;
const CODEX_PATH_RESOLUTION_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "CODEX_INSTALL_DIR",
]);

function cursorExecutablePreference(executable: string): number {
  const name = basename(executable).toLowerCase().replace(/\.(?:bat|cmd|exe)$/u, "");
  return name === "cursor-agent" ? 1 : 0;
}

function cursorCandidateIsIdentified(
  executable: string,
  versionOutput: string,
  acpOutput: string,
): boolean {
  return cursorExecutablePreference(executable) > 0
    || /\bcursor(?:[ -]agent)?\b/iu.test(`${versionOutput}\n${acpOutput}`);
}

function kimiCandidateIsIdentified(
  executable: string,
  versionOutput: string,
  acpOutput: string,
): boolean {
  const name = basename(executable).toLowerCase().replace(/\.(?:bat|cmd|exe)$/u, "");
  return name === "kimi" || /\bkimi(?:[ -]code)?\b/iu.test(`${versionOutput}\n${acpOutput}`);
}

function versionFromOutput(output: string): string | undefined {
  return output.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0];
}

interface ProbeResult {
  exitCode: number | null;
  output: string;
  started: boolean;
  timedOut: boolean;
  cleanupConfirmed?: boolean;
}

type ProviderProbeProcess = (
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
) => Promise<ProbeResult>;

interface ProviderProbeDeadline {
  cancel(): void;
}

type ProviderProbeDeadlineScheduler = (
  onDeadline: () => void,
  timeoutMs: number,
) => ProviderProbeDeadline;

function scheduleProviderProbeDeadline(
  onDeadline: () => void,
  timeoutMs: number,
): ProviderProbeDeadline {
  const timer = setTimeout(onDeadline, timeoutMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

interface ProviderDiscoveryDependencies {
  executableCandidates?: typeof executableCandidates;
  probeProcess?: ProviderProbeProcess;
  terminateProcessTree?: ProcessTreeTerminator;
  scheduleProbeDeadline?: ProviderProbeDeadlineScheduler;
}

async function probeProcess(
  executable: string,
  args: readonly string[],
  environment: ProviderEnvironment,
  cwd: string,
  timeoutMs: number,
  terminateProcessTree: ProcessTreeTerminator = terminateProcessTreeAndWait,
  scheduleDeadline: ProviderProbeDeadlineScheduler = scheduleProviderProbeDeadline,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolveProbe) => {
    const output = new CappedProviderBuffer(16 * 1024);
    let settled = false;
    let started = false;
    let timedOut = false;
    let deadline: ProviderProbeDeadline | undefined;
    const finish = (
      exitCode: number | null,
      cleanupConfirmed = true,
    ): void => {
      if (settled) return;
      settled = true;
      deadline?.cancel();
      resolveProbe({
        exitCode,
        output: output.toString(),
        started,
        timedOut,
        cleanupConfirmed,
      });
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      const invocation = providerProcessInvocation(executable, args, environment.env);
      const ownedInvocation = runtimeOwnedProcessInvocation(
        invocation.command,
        invocation.args,
      );
      child = spawnRuntimeOwnedProcess(() => spawn(ownedInvocation.command, ownedInvocation.args, {
        cwd,
        env: environment.env,
        detached: process.platform !== "win32",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }));
    } catch {
      finish(null);
      return;
    }

    child.once("spawn", () => { started = true; });
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
    const terminateAndFinish = (): void => {
      if (settled) return;
      settled = true;
      deadline?.cancel();
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
    };
    child.once("error", () => {
      if (started) terminateAndFinish();
      else finish(null);
    });
    child.once("close", (code) => finish(code));
    child.stdin.end();

    deadline = scheduleDeadline(() => {
      if (settled) return;
      timedOut = true;
      terminateAndFinish();
    }, timeoutMs);
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

  if (providerId === "kimi") {
    if (/not (?:logged|signed) in|authentication required|please (?:log|sign) in/iu.test(lower)) {
      return "unauthenticated";
    }
    try {
      const status = JSON.parse(normalized) as { providers?: unknown };
      if (
        status.providers
        && typeof status.providers === "object"
        && !Array.isArray(status.providers)
        && Object.keys(status.providers).length > 0
      ) return "configured";
    } catch { /* Older Kimi Code releases may return a text table. */ }
    if (probe.exitCode === 0 && /\b(?:kimi|anthropic|openai)\b/iu.test(lower)) {
      return "configured";
    }
    return "unknown";
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
  const scheduleProbeDeadline = dependencies.scheduleProbeDeadline
    ?? scheduleProviderProbeDeadline;
  const runProbe: ProviderProbeProcess = dependencies.probeProcess
    ?? (async (...args) => await probeProcess(
      ...args,
      terminateProcessTree,
      scheduleProbeDeadline,
    ));
  const provider = PROVIDER_INFO[providerId];
  const command = options.command?.trim() || provider.command;
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS, 10_000));
  const cwd = options.cwd ?? process.cwd();
  const discoveredEnvironment = await providerEnvironment(
    options.refreshEnvironment === true,
  );
  const probeAuthentication = options.probeAuthentication !== false;
  const probeEnvironment: ProviderEnvironment = {
    env: credentialFreeProviderEnvironment(discoveredEnvironment.env),
    pathEntries: discoveredEnvironment.pathEntries,
  };
  const candidateEnvironment: ProviderEnvironment = providerId === "codex"
    ? {
        env: {
          ...probeEnvironment.env,
          ...Object.fromEntries(
            [...CODEX_PATH_RESOLUTION_ENVIRONMENT_KEYS].flatMap((name) => {
              const value = environmentValue(
                discoveredEnvironment.env,
                name,
                process.platform,
              );
              return value ? [[name, value]] : [];
            }),
          ),
        },
        pathEntries: probeEnvironment.pathEntries,
      }
    : probeEnvironment;
  const candidateCommands = providerId === "cursor" && command === PROVIDER_INFO.cursor.command
    ? [command, "agent"]
    : [command];
  const candidates = providerId === "codex"
    && process.platform === "win32"
    && command.toLocaleLowerCase("en-US") === PROVIDER_INFO.codex.command
    && dependencies.executableCandidates === undefined
    ? await windowsCodexExecutableCandidates(candidateEnvironment, cwd)
    : [...new Set((await Promise.all(candidateCommands.map(
      async (candidate) => await resolveCandidates(
        candidate,
        candidateEnvironment,
        cwd,
      ),
    ))).flat())];
  if (candidates.length === 0) {
    return {
      provider,
      available: false,
      installState: "not-installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: true,
      statusMessage: providerId === "codex" ? "Codex CLI not found" : statusMessage("not-installed", "unknown"),
    };
  }

  const versionProbes = await Promise.all(candidates.map(async (executable) => {
    const probe = await runProbe(executable, ["--version"], probeEnvironment, cwd, timeoutMs);
    const acpProbe = (providerId === "cursor" || providerId === "kimi")
      && probe.started && !probe.timedOut && probe.exitCode === 0
      ? await runProbe(
          executable,
          providerId === "cursor"
            ? cursorAgentCommandArgs(executable, ["acp", "--help"])
            : ["acp", "--help"],
          probeEnvironment,
          cwd,
          timeoutMs,
        )
      : undefined;
    const acpReady = !acpProbe || (
      acpProbe.started
      && !acpProbe.timedOut
      && acpProbe.exitCode === 0
      && /(?:agent client protocol|\bacp\b|cursor|kimi)/iu.test(acpProbe.output)
      && (providerId === "cursor"
        ? cursorCandidateIsIdentified(executable, probe.output, acpProbe.output)
        : kimiCandidateIsIdentified(executable, probe.output, acpProbe.output))
    );
    const appServerProbe = providerId === "codex" && probe.started && !probe.timedOut && probe.exitCode === 0
      ? await runProbe(executable, ["app-server", "--help"], probeEnvironment, cwd, timeoutMs)
      : undefined;
    const appServerReady = !appServerProbe || (
      appServerProbe.started
      && !appServerProbe.timedOut
      && appServerProbe.exitCode === 0
      && /(?:codex\s+app-server|run the app server|\bapp-server\b)/iu.test(appServerProbe.output)
    );
    return {
      executable,
      probe,
      version: versionFromOutput(probe.output),
      acpReady,
      appServerReady,
      cleanupConfirmed: probe.cleanupConfirmed === true
        && (acpProbe === undefined || acpProbe.cleanupConfirmed === true)
        && (appServerProbe === undefined || appServerProbe.cleanupConfirmed === true),
    };
  }));
  const working = versionProbes
    .filter(({ probe, acpReady }) => probe.started && !probe.timedOut && probe.exitCode === 0 && acpReady)
    .sort((left, right) =>
      (providerId === "cursor"
        ? cursorExecutablePreference(right.executable)
          - cursorExecutablePreference(left.executable)
        : 0)
      || compareVersions(right.version, left.version)
      || nativeExecutablePreference(right.executable) - nativeExecutablePreference(left.executable));
  const selected = providerId === "codex"
    ? working.find(({ appServerReady }) => appServerReady) ?? working[0]
    : working[0];
  if (!selected) {
    const cleanupUnconfirmed = versionProbes.some(
      ({ cleanupConfirmed }) => !cleanupConfirmed,
    );
    const providerWithoutAcp = (providerId === "cursor" || providerId === "kimi") && versionProbes.some(
      ({ probe }) => probe.started && !probe.timedOut && probe.exitCode === 0,
    );
    return {
      provider,
      available: providerWithoutAcp,
      installState: providerWithoutAcp ? "installed" : "error",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: !cleanupUnconfirmed,
      statusMessage: cleanupUnconfirmed
        ? `${provider.name} probe timed out, and its process tree could not be confirmed stopped`
        : providerWithoutAcp
        ? `${provider.name} CLI found, but ACP is unavailable`
        : providerId === "codex" ? "Codex CLI was found but failed to start" : statusMessage("error", "unknown"),
    };
  }

  if (!probeAuthentication) {
    const cleanupConfirmed = versionProbes.every((probe) => probe.cleanupConfirmed);
    return {
      provider,
      available: true,
      executable: selected.executable,
      ...(selected.version ? { version: selected.version } : {}),
      installState: "installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed,
      statusMessage: providerId === "codex" && !selected.appServerReady
        ? "Codex App Server is unsupported; update the selected CLI"
        : `${provider.name} is installed; authentication was not checked`,
    };
  }

  const versionCleanupConfirmed = versionProbes.every(
    (probe) => probe.cleanupConfirmed,
  );
  if (!versionCleanupConfirmed || (providerId === "codex" && !selected.appServerReady)) {
    return {
      provider,
      available: true,
      executable: selected.executable,
      ...(selected.version ? { version: selected.version } : {}),
      installState: "installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: versionCleanupConfirmed,
      statusMessage: !versionCleanupConfirmed
        ? `${provider.name} probe cleanup could not be confirmed stopped`
        : "Codex App Server is unsupported; update the selected CLI",
    };
  }

  const authArgs = providerId === "cursor"
    ? cursorAgentCommandArgs(
        selected.executable,
        providerAuthStatusArgs(providerId),
      )
    : providerAuthStatusArgs(providerId);
  const authProbe = await runProbe(
    selected.executable,
    authArgs,
    {
      env: providerChildEnvironment(providerId, discoveredEnvironment.env),
      pathEntries: discoveredEnvironment.pathEntries,
    },
    cwd,
    timeoutMs,
  );
  const authState = authStateFromProbe(providerId, authProbe);
  const authenticated = authState === "authenticated" || authState === "configured";
  // `kimi provider list --json` enumerates configured API providers, but a
  // valid managed OAuth login need not appear there. Kimi ACP owns the
  // authoritative `authenticate` exchange at session startup, so an otherwise
  // healthy ACP install with unknown static auth remains admissible. A known
  // unauthenticated result is still blocked, and AUTH_REQUIRED is translated
  // into an actionable runtime error by the native harness.
  const runtimeNegotiatesAuthentication = providerId === "kimi"
    && authState === "unknown";
  const appServerReady = selected.appServerReady;
  const cleanupConfirmed = authProbe.cleanupConfirmed === true
    && versionCleanupConfirmed;
  const canRun = (authenticated || runtimeNegotiatesAuthentication)
    && appServerReady
    && cleanupConfirmed;
  return {
    provider,
    available: true,
    executable: selected.executable,
    ...(selected.version ? { version: selected.version } : {}),
    installState: "installed",
    authState,
    canRun,
    cleanupConfirmed,
    statusMessage: !versionCleanupConfirmed
      ? `${provider.name} probe cleanup could not be confirmed stopped`
      : authProbe.cleanupConfirmed !== true
      ? `${provider.name} connection probe timed out, and its process tree could not be confirmed stopped`
      : providerId === "codex" && !appServerReady
      ? "Codex App Server is unsupported; update the selected CLI"
      : runtimeNegotiatesAuthentication
      ? "Installed; Kimi ACP will verify sign-in when a session starts"
      : statusMessage("installed", authState),
  };
}

export async function detectProviders(
  options: Partial<Record<ProviderId, ProviderDetectionOptions>> = {},
): Promise<ProviderDetection[]> {
  return await Promise.all(PROVIDER_IDS.map((id) => detectProvider(id, options[id])));
}
