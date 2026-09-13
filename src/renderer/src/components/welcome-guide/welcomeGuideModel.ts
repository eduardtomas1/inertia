import type { ProviderInfo } from "@shared/contracts";

export const WELCOME_STEPS = [
  { id: "welcome", title: "Welcome", primary: "Take the tour" },
  { id: "tour", title: "How it works", primary: "Connect an agent" },
  { id: "agents", title: "Connect an agent", primary: "Continue" },
  { id: "start", title: "Start", primary: "Start using Inertia" },
] as const;

export type WelcomeTopicId = "chat" | "split" | "duo" | "review" | "limits";

export const WELCOME_TOPICS: ReadonlyArray<{
  id: WelcomeTopicId;
  title: string;
  detail: string;
}> = [
  {
    id: "chat",
    title: "Chat with context",
    detail: "Attach images and documents, mention files, and choose the model and access mode. Queue follow-ups while an agent works.",
  },
  {
    id: "split",
    title: "Work side by side",
    detail: "Open two chats in split view or move one into its own window. Each keeps its own project, files, terminal and draft.",
  },
  {
    id: "duo",
    title: "Duo",
    detail: "Send one brief to two agents, then ask a third model to compare what they did.",
  },
  {
    id: "review",
    title: "Review and ship",
    detail: "Inspect diffs, mark reviewed hunks, commit only the files you choose and open a pull request.",
  },
  {
    id: "limits",
    title: "Usage and limits",
    detail: "Follow recorded usage and each account's remaining quota and reset time.",
  },
];

export type ProviderReadiness = "ready" | "sign-in" | "install" | "checking" | "attention";

export const PROVIDER_READINESS_LABELS: Record<ProviderReadiness, string> = {
  ready: "Ready",
  "sign-in": "Sign in needed",
  install: "Not installed",
  checking: "Checking…",
  attention: "Needs attention",
};

export function providerReadiness(
  provider: Pick<ProviderInfo, "canRun" | "installState" | "authState">,
): ProviderReadiness {
  if (provider.canRun) return "ready";
  if (provider.installState === "checking" || provider.authState === "checking") {
    return "checking";
  }
  if (provider.installState === "not-installed") return "install";
  if (provider.authState === "unauthenticated") return "sign-in";
  return "attention";
}

export function clampWelcomeStep(step: number): number {
  return Math.min(WELCOME_STEPS.length - 1, Math.max(0, step));
}
