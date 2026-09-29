export const MAX_ANALYZED_FILE_BYTES: number;

export function analyzeSourceArchitecture(options: {
  workspaceRoot: string;
  sourceDirectory?: string;
  configPaths?: readonly string[];
  allowedLayers?: ReadonlyMap<string, ReadonlySet<string>>;
  platformNeutralLayers?: ReadonlySet<string>;
  allowedAssetImports?: readonly { from: string; directory: string }[];
}): { failures: string[] };
