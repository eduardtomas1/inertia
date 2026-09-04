export interface GeminiCliArtifactInspectionLimits {
  maxArtifactBytes?: number;
  maxFiles?: number;
  maxPackageJsonBytes?: number;
  maxTotalBytes?: number;
}

export interface GeminiCliArtifactInspectionResult {
  filesInspected: number;
  totalBytes: number;
}

export function inspectGeminiCliAcpSurface(
  packageDirectory: string,
  limits?: GeminiCliArtifactInspectionLimits,
): Promise<GeminiCliArtifactInspectionResult>;
