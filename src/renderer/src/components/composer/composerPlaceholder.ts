export interface ComposerPlaceholderState {
  disabled: boolean;
  running: boolean;
  stopsBeforeSending: boolean;
  queueBlocked: boolean;
  hasHistory: boolean;
  skillsAvailable: boolean;
}

export function skillsMenuEnabled({
  disabled,
  running,
  skillsAvailable,
}: Pick<ComposerPlaceholderState, "disabled" | "running" | "skillsAvailable">): boolean {
  return skillsAvailable && !disabled && !running;
}

export function composerTriggerHint(
  state: Pick<ComposerPlaceholderState, "disabled" | "running" | "skillsAvailable">,
): string {
  return [
    ...(state.running ? [] : ["@ files"]),
    ...(skillsMenuEnabled(state) ? ["$ skills"] : []),
    "/ commands",
  ].join(", ");
}

export function composerPlaceholder(state: ComposerPlaceholderState): string {
  const prompt = state.hasHistory ? "Follow up." : "Ask anything.";
  if (state.disabled) return prompt;
  if (state.stopsBeforeSending && !state.queueBlocked) return "Enter stops and sends · Tab queues";
  if (state.running && !state.queueBlocked) return "Enter sends · Tab queues";
  return `${prompt} ${composerTriggerHint(state)}`;
}
