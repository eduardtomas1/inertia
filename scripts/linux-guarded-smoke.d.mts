export function runLinuxGuardedSmoke(options: {
  guardian: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string>;
