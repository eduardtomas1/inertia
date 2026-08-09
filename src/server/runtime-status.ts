import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runGitInspection } from "./git/runner";
import { PROVIDER_INFO } from "./provider/catalog";
import {
  PROVIDER_IDS,
  type ProviderDetection,
  type ProviderDetectionOptions,
  type ProviderId,
} from "./provider/contracts";
import { detectProvider } from "./provider/discovery";

const STATUS_PROBE_TIMEOUT_MS = 3_000;
const STATUS_GIT_OUTPUT_BYTES = 4 * 1024;

export type RuntimeEnvironmentKind =
  | "local"
  | "ssh"
  | "codespaces"
  | "dev-container"
  | "wsl"
  | "container";

export type SourceControlKind =
  | "git"
  | "jujutsu"
  | "mercurial"
  | "subversion"
  | "fossil";

export interface RuntimeEnvironmentReadiness {
  kind: RuntimeEnvironmentKind;
  remote: boolean;
  workspaceReadable: boolean;
  workspaceWritable: boolean;
  /** Readiness is intentionally scoped to local filesystem inspection. */
  inspectionReady: boolean;
}

export interface SourceControlReadiness {
  kind: SourceControlKind;
  scope: "workspace" | "ancestor";
  inspectionReady: boolean;
  inspectionSupport: "supported" | "unsupported";
  /** The diagnostic never performs a write to infer operational readiness. */
  mutationReadiness: "not-checked" | "unsupported";
  mutationSupport: "supported" | "unsupported";
}

export interface ProviderInstallationReadiness {
  id: ProviderId;
  name: string;
  available: boolean;
  version: string | null;
  installState: ProviderDetection["installState"];
  /** Always unknown because the diagnostic never performs an auth probe. */
  authState: "unknown";
  canRun: false;
  statusMessage: string;
}

export interface RuntimeStatusReport {
  schemaVersion: 1;
  checkedAt: string;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  environment: RuntimeEnvironmentReadiness;
  sourceControl: SourceControlReadiness[];
  providers: ProviderInstallationReadiness[];
}

export interface RuntimeStatusOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

type DetectProvider = (
  providerId: ProviderId,
  options?: ProviderDetectionOptions,
) => Promise<ProviderDetection>;

export interface RuntimeStatusDependencies {
  detectProvider?: DetectProvider;
  now?: () => Date;
}

export class RuntimeStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeStatusError";
  }
}

function hasEnvironmentMarker(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): boolean {
  const normalized = new Map(
    Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]),
  );
  return names.some((name) => {
    const value = normalized.get(name.toUpperCase());
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  });
}

/** Detects only the presence of conventional non-secret environment markers. */
export function runtimeEnvironmentKind(
  environment: NodeJS.ProcessEnv,
): RuntimeEnvironmentKind {
  if (hasEnvironmentMarker(environment, ["CODESPACES", "CODESPACE_NAME"])) {
    return "codespaces";
  }
  if (hasEnvironmentMarker(environment, ["REMOTE_CONTAINERS", "DEVCONTAINER"])) {
    return "dev-container";
  }
  if (hasEnvironmentMarker(environment, ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])) {
    return "ssh";
  }
  if (hasEnvironmentMarker(environment, ["WSL_DISTRO_NAME", "WSL_INTEROP"])) {
    return "wsl";
  }
  if (hasEnvironmentMarker(environment, ["CONTAINER", "container"])) {
    return "container";
  }
  return "local";
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not-directory");
    return canonical;
  } catch {
    throw new RuntimeStatusError("The status path must be an existing directory.");
  }
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

const SOURCE_CONTROL_MARKERS: ReadonlyArray<{
  kind: SourceControlKind;
  names: readonly string[];
}> = [
  { kind: "git", names: [".git"] },
  { kind: "jujutsu", names: [".jj"] },
  { kind: "mercurial", names: [".hg"] },
  { kind: "subversion", names: [".svn"] },
  { kind: "fossil", names: [".fslckout", "_FOSSIL_"] },
];

async function hasFixedMarker(directory: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      const details = await lstat(join(directory, name));
      if (!details.isSymbolicLink() && (details.isDirectory() || details.isFile())) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
  return false;
}

async function detectedSourceControls(
  cwd: string,
): Promise<Array<{ kind: SourceControlKind; scope: "workspace" | "ancestor" }>> {
  const result: Array<{
    kind: SourceControlKind;
    scope: "workspace" | "ancestor";
  }> = [];
  const found = new Set<SourceControlKind>();
  let current = cwd;
  let scope: "workspace" | "ancestor" = "workspace";
  while (true) {
    for (const marker of SOURCE_CONTROL_MARKERS) {
      if (!found.has(marker.kind) && await hasFixedMarker(current, marker.names)) {
        found.add(marker.kind);
        result.push({ kind: marker.kind, scope });
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    scope = "ancestor";
  }
  return result;
}

async function gitInspectionReady(cwd: string): Promise<boolean> {
  try {
    const result = await runGitInspection(cwd, ["rev-parse", "--is-inside-work-tree"], {
      failureMessage: "Unable to inspect Git readiness.",
      maxOutputBytes: STATUS_GIT_OUTPUT_BYTES,
      timeoutMs: STATUS_PROBE_TIMEOUT_MS,
    });
    return result.stdout.toString("utf8").trim() === "true";
  } catch {
    return false;
  }
}

async function sourceControlReadiness(
  cwd: string,
): Promise<SourceControlReadiness[]> {
  const detected = await detectedSourceControls(cwd);
  const gitReady = detected.some(({ kind }) => kind === "git")
    ? await gitInspectionReady(cwd)
    : false;
  return detected.map(({ kind, scope }) => {
    const supported = kind === "git";
    return {
      kind,
      scope,
      inspectionReady: supported && gitReady,
      inspectionSupport: supported ? "supported" : "unsupported",
      mutationReadiness: supported ? "not-checked" : "unsupported",
      mutationSupport: supported ? "supported" : "unsupported",
    };
  });
}

function providerReadiness(
  providerId: ProviderId,
  detection: ProviderDetection | null,
): ProviderInstallationReadiness {
  const provider = PROVIDER_INFO[providerId];
  if (!detection) {
    return {
      id: providerId,
      name: provider.name,
      available: false,
      version: null,
      installState: "error",
      authState: "unknown",
      canRun: false,
      statusMessage: "Installation readiness could not be checked",
    };
  }
  return {
    id: providerId,
    name: provider.name,
    available: detection.available,
    version: detection.version ?? null,
    installState: detection.installState,
    authState: "unknown",
    canRun: false,
    statusMessage: detection.statusMessage ?? "Installation readiness checked",
  };
}

export async function collectRuntimeStatus(
  options: RuntimeStatusOptions = {},
  dependencies: RuntimeStatusDependencies = {},
): Promise<RuntimeStatusReport> {
  const cwd = await canonicalDirectory(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const kind = runtimeEnvironmentKind(environment);
  const [workspaceReadable, workspaceWritable] = await Promise.all([
    canAccess(cwd, fsConstants.R_OK),
    canAccess(cwd, fsConstants.W_OK),
  ]);
  const detect = dependencies.detectProvider ?? detectProvider;
  const [sourceControl, providerResults] = await Promise.all([
    sourceControlReadiness(cwd),
    Promise.all(PROVIDER_IDS.map(async (providerId) => {
      try {
        return await detect(providerId, {
          cwd,
          timeoutMs: STATUS_PROBE_TIMEOUT_MS,
          probeAuthentication: false,
        });
      } catch {
        return null;
      }
    })),
  ]);
  return {
    schemaVersion: 1,
    checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    environment: {
      kind,
      remote: kind !== "local",
      workspaceReadable,
      workspaceWritable,
      inspectionReady: workspaceReadable,
    },
    sourceControl,
    providers: PROVIDER_IDS.map((providerId, index) =>
      providerReadiness(providerId, providerResults[index] ?? null)),
  };
}
