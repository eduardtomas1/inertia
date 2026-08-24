export interface CanaryFeedStatus {
  version: string;
  tag: string;
}

export function parseCanaryFeedStatus(source: string, label: string): CanaryFeedStatus;
export function compareCanaryVersions(left: string, right: string): -1 | 0 | 1;
export function validateCanaryFeedAdvance(
  currentSource: string | null,
  candidateSource: string,
): CanaryFeedStatus | null;
