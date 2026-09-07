export interface ElectronRuntimePreparationInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
  readonly timeoutMs: number;
}

export function prepareElectronRuntime(options: {
  readonly root: string;
  readonly run: (invocation: ElectronRuntimePreparationInvocation) => Promise<unknown>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}): Promise<void>;
