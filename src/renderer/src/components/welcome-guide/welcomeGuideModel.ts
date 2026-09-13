import type { ProviderInfo } from "@shared/contracts";

import type { WelcomeShortcut } from "../../utils/welcomeGuide";

export const WELCOME_STEPS = [
  { id: "welcome", title: "Welcome", primary: "Take the tour" },
  { id: "tour", title: "How it works", primary: "Connect an agent" },
  { id: "agents", title: "Connect an agent", primary: "Continue" },
  { id: "start", title: "Start", primary: "Start using Inertia" },
] as const;

export type WelcomeTopicId = "split" | "work" | "duo" | "ship" | "limits" | "keys";

export const WELCOME_TOPICS: ReadonlyArray<{
  id: WelcomeTopicId;
  title: string;
  detail: string;
}> = [
  {
    id: "split",
    title: "Split view",
    detail: "Drag a chat onto the workspace to split it, up to four chats at once.",
  },
  {
    id: "work",
    title: "Work tab",
    detail: "Running chats show live progress in the Work tab and check off when they finish.",
  },
  {
    id: "duo",
    title: "Duo",
    detail: "Send one brief to two agents, then let a third model judge the results.",
  },
  {
    id: "ship",
    title: "Review and ship",
    detail: "Mark reviewed hunks, commit the files you choose and open a pull request.",
  },
  {
    id: "limits",
    title: "Limits",
    detail: "See each account's remaining quota and next reset at a glance.",
  },
  {
    id: "keys",
    title: "Shortcuts",
    detail: "Press {search} to search everything and {newChat} for a new chat.",
  },
];

export const WELCOME_TILES: ReadonlyArray<{
  demo: WelcomeTopicId;
  title: string;
  detail: string;
}> = [
  { demo: "work", title: "Follow every agent", detail: "Live progress for each running chat." },
  { demo: "split", title: "Work side by side", detail: "Drag a chat onto the workspace to split it." },
  { demo: "ship", title: "Review, then ship", detail: "Mark hunks, commit and open a pull request." },
];

export function topicDetail(
  detail: string,
  shortcuts: readonly WelcomeShortcut[],
): string {
  const keys = (label: string, fallback: string): string =>
    shortcuts.find((shortcut) => shortcut.label === label)?.keys ?? fallback;
  return detail
    .replace("{search}", keys("Search", "⌘K"))
    .replace("{newChat}", keys("New chat", "⌘N"));
}

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
