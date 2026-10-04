export const PROJECT_REPOSITORY_DISPLAY_LIMITS = [16, 32] as const;

export function projectRepositoryLimitChoices(stored: number): readonly number[] {
  return [...new Set<number>([...PROJECT_REPOSITORY_DISPLAY_LIMITS, stored])].sort((left, right) => left - right);
}
