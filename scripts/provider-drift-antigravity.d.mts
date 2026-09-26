export const ANTIGRAVITY_MANIFEST_URL: string;
export function parseAntigravityManifest(text: string): {
  version: string; url: string; sha512: string;
};
export function stageAntigravityCli(root: string, environment: NodeJS.ProcessEnv,
  run: (command: string, args: string[], options: {
    cwd: string; environment: NodeJS.ProcessEnv; timeoutMs: number; allowEmpty?: boolean;
  }) => Promise<string>,
): Promise<{ executable: string; version: string }>;
