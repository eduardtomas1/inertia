export const PROJECT_REPOSITORY_DISPLAY_LIMITS = [16, 32] as const;
export type ProjectRepositoryDisplayLimit = (typeof PROJECT_REPOSITORY_DISPLAY_LIMITS)[number];
export function projectRepositoryDisplayLimit(limit: number): ProjectRepositoryDisplayLimit {
  return limit >= 32 ? 32 : 16;
}
