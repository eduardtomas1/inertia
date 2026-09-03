export function providerDriftEnvironment(
  isolatedRoot: string,
  source?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function providerDriftEnvironmentDirectories(
  environment: NodeJS.ProcessEnv,
): string[];

export function prepareProviderDriftEnvironment(
  isolatedRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void>;
