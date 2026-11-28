import type { KnownHarnessId } from "./model-routing";

export type HarnessSteeringCapabilitySupport = "native" | "negotiated" | "unavailable";

/**
 * Shared, environment-neutral steering and native-resume capability truth per
 * production harness. The server capability manifest imports this directly so
 * server and renderer stay aligned without pulling Node modules into the
 * renderer bundle.
 */
export interface HarnessSteeringCapabilities {
  readonly followUpSteer: HarnessSteeringCapabilitySupport;
  readonly steerAcceptsAttachments: HarnessSteeringCapabilitySupport;
  readonly steerDuringCompaction: HarnessSteeringCapabilitySupport;
  readonly nativeResume: HarnessSteeringCapabilitySupport;
}

export const HARNESS_STEERING_CAPABILITIES: Readonly<
  Partial<Record<KnownHarnessId, HarnessSteeringCapabilities>>
> = Object.freeze({
  "codex-app-server": Object.freeze({
    followUpSteer: "native",
    steerAcceptsAttachments: "native",
    steerDuringCompaction: "native",
    nativeResume: "native",
  }),
  "claude-agent-sdk": Object.freeze({
    followUpSteer: "native",
    steerAcceptsAttachments: "native",
    steerDuringCompaction: "native",
    nativeResume: "native",
  }),
  "opencode-sdk": Object.freeze({
    followUpSteer: "native",
    steerAcceptsAttachments: "negotiated",
    steerDuringCompaction: "unavailable",
    nativeResume: "native",
  }),
  "pi-rpc": Object.freeze({
    followUpSteer: "native",
    steerAcceptsAttachments: "native",
    steerDuringCompaction: "unavailable",
    nativeResume: "unavailable",
  }),
  "cursor-sdk": Object.freeze({
    followUpSteer: "native",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "native",
  }),
  "cursor-acp": Object.freeze({
    followUpSteer: "unavailable",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "negotiated",
  }),
  "kimi-acp": Object.freeze({
    followUpSteer: "unavailable",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "negotiated",
  }),
  "grok-acp": Object.freeze({
    followUpSteer: "unavailable",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "negotiated",
  }),
  "antigravity-acp": Object.freeze({
    followUpSteer: "unavailable",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "negotiated",
  }),
  "antigravity-cli": Object.freeze({
    followUpSteer: "unavailable",
    steerAcceptsAttachments: "unavailable",
    steerDuringCompaction: "unavailable",
    nativeResume: "unavailable",
  }),
});

export function harnessSteeringCapabilities(
  harnessId: string | null,
): HarnessSteeringCapabilities | null {
  if (harnessId === null) return null;
  return HARNESS_STEERING_CAPABILITIES[harnessId as KnownHarnessId] ?? null;
}

export function supportsActiveParentFollowUp(harnessId: string | null): boolean {
  return harnessSteeringCapabilities(harnessId)?.followUpSteer === "native";
}

export function supportsSteerAttachments(harnessId: string | null): boolean {
  const support = harnessSteeringCapabilities(harnessId)?.steerAcceptsAttachments;
  return support === "native" || support === "negotiated";
}

export function supportsSteerDuringCompaction(harnessId: string | null): boolean {
  return harnessSteeringCapabilities(harnessId)?.steerDuringCompaction === "native";
}

export function supportsNativeResume(harnessId: string | null): boolean {
  return harnessSteeringCapabilities(harnessId)?.nativeResume === "native";
}

/** T3 `c38537754`: slash-command-only prompts must run as their own turn, never steer an active turn. */
export const COMMAND_ONLY_STEER_REFUSED = "Commands must run as a separate turn. Queue it or wait for the active turn to finish.";
const COMMAND_ONLY_PROMPT_PATTERN = /^\/[\w:-]+(?:\s|$)/u;

export function isCommandOnlyPrompt(content: string, attachmentCount = 0): boolean {
  return attachmentCount === 0 && COMMAND_ONLY_PROMPT_PATTERN.test(content.trim());
}
