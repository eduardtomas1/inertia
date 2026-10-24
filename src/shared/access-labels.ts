type InteractionMode = "build" | "plan";
type AccessMode = "supervised" | "auto-edit" | "full";

export const INTERACTION_MODE_LABELS: Readonly<Record<InteractionMode, string>> = {
  build: "Build",
  plan: "Plan",
};

export const ACCESS_MODE_LABELS: Readonly<Record<AccessMode, string>> = {
  supervised: "Supervised",
  "auto-edit": "Auto-accept edits",
  full: "Full access",
};

export function watcherAccessLabel(
  link: { readOnly: boolean },
  conversation: { interactionMode: InteractionMode; accessMode: AccessMode } | null,
): string {
  if (link.readOnly) return "Read-only";
  if (conversation === null) return "Chat access";
  return `${INTERACTION_MODE_LABELS[conversation.interactionMode]} · ${ACCESS_MODE_LABELS[conversation.accessMode]}`;
}
