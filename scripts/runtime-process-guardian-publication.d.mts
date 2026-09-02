export interface GuardianBuildLock {
  heartbeat?: ReturnType<typeof setInterval> | null;
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

export function guardianFileSyncOpenFlags(
  platform?: NodeJS.Platform,
): "r" | "r+";

export interface GuardianBuildTargets {
  readonly guardian: string;
  readonly integrity: string;
  readonly windowsJob: string;
}

export function acquireGuardianBuildLock(
  stateDirectory: string,
  options?: { readonly timeoutMs?: number },
): GuardianBuildLock;

export function releaseGuardianBuildLock(lock: GuardianBuildLock): void;

export function beginGuardianBuildChildLaunch(lock: GuardianBuildLock): void;

export function recordGuardianBuildChild(
  lock: GuardianBuildLock,
  child: {
    readonly pid: number;
    readonly processGroupId: number | null;
  },
): void;

export function clearGuardianBuildChild(lock: GuardianBuildLock): void;
export function quarantineGuardianBuildChild(lock: GuardianBuildLock): void;

export function renewGuardianBuildLock(lock: GuardianBuildLock): void;

export function startGuardianBuildLockHeartbeat(
  lock: GuardianBuildLock,
  options?: {
    readonly intervalMs?: number;
    readonly onCompromised?: (error: unknown) => void;
  },
): () => void;

export function cleanGuardianLockArtifacts(
  stateDirectory: string,
  lock: GuardianBuildLock,
): void;

export function reclaimStaleGuardianBuildLock(
  stateDirectory: string,
  lockPath: string,
  options?: {
    readonly beforeClaimantPublication?: () => void;
    readonly beforeUnlink?: () => void;
  },
): boolean;

export function validateGuardianExecutable(path: string, label: string): void;

export function validateGuardianArtifactSet(
  platform: NodeJS.Platform,
  targets: GuardianBuildTargets,
  expectedHash?: string,
): void;

export function recoverGuardianPublication(
  stateDirectory: string,
  targets: GuardianBuildTargets,
): boolean;

export function cleanGuardianBuildState(stateDirectory: string): void;

export function cleanLegacyGuardianStages(targets: GuardianBuildTargets): void;

export function publishGuardianArtifacts(options: {
  readonly expectedWindowsHash?: string;
  readonly failAfterOperation?: number;
  readonly platform: NodeJS.Platform;
  readonly stagedExecutable: string | null;
  readonly stateDirectory: string;
  readonly targets: GuardianBuildTargets;
}): void;
