export class ProcessTreeCleanupError extends Error {
  readonly preserveTemporaryRoot: true;
}

export class BoundedProcessTimeoutError extends Error {
  readonly cleanupConfirmed: true;
}

export class BoundedProcessExitError extends Error {
  readonly cleanupConfirmed: true;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function runBounded(
  command: string,
  args: readonly string[],
  options: {
    readonly combineOutput?: boolean;
    readonly cwd?: string;
    readonly echoOutput?: boolean;
    readonly echoOutputLive?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: Buffer | string;
    readonly label: string;
    readonly maxOutputBytes?: number;
    readonly onOutput?: (
      stream: "stderr" | "stdout",
      chunk: Buffer,
    ) => void;
    readonly onSpawn?: (child: {
      readonly pid: number;
      readonly processGroupId: number | null;
    }) => void;
    readonly posixProcessGroupHandoff?: {
      readonly ownerToken: string;
      readonly path: string;
    };
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly windowsJobGuardian?: {
      readonly cleanupTimeoutMs?: number;
      readonly integrityPath?: string;
      readonly path?: string;
      readonly readyTimeoutMs?: number;
    };
  },
): Promise<string>;

export function posixProcessGroupKillIsConfirmed(
  error: NodeJS.ErrnoException | null,
  groupStillExists: boolean,
): boolean;

export function linuxProcessGroupCanExecute(
  processGroupId: number,
  dependencies?: {
    readonly processIds?: () => string[];
    readonly readStat?: (pid: string) => string;
  },
): boolean | null;
