import anthropicIcon from "../assets/provider-icons/anthropic.svg?no-inline";
import cursorDarkIcon from "../assets/provider-icons/cursor-dark.svg?no-inline";
import cursorLightIcon from "../assets/provider-icons/cursor-light.svg?no-inline";
import openaiIcon from "../assets/provider-icons/openai.svg?no-inline";
import opencodeDarkIcon from "../assets/provider-icons/opencode-dark.svg?no-inline";
import opencodeLightIcon from "../assets/provider-icons/opencode-light.svg?no-inline";

import type { ProviderId } from "@shared/contracts";

export type ProviderIconDefinition = Readonly<{
  providerId: ProviderId;
  brand: "openai" | "anthropic" | "cursor" | "opencode";
  label: string;
  lightSrc: string;
  darkSrc?: string;
  invertInDark?: boolean;
}>;

const providerIconDefinitions: Readonly<Record<ProviderId, ProviderIconDefinition>> = {
  codex: {
    providerId: "codex",
    brand: "openai",
    label: "OpenAI",
    lightSrc: openaiIcon,
    invertInDark: true,
  },
  claude: {
    providerId: "claude",
    brand: "anthropic",
    label: "Anthropic",
    lightSrc: anthropicIcon,
  },
  cursor: {
    providerId: "cursor",
    brand: "cursor",
    label: "Cursor",
    lightSrc: cursorLightIcon,
    darkSrc: cursorDarkIcon,
  },
  opencode: {
    providerId: "opencode",
    brand: "opencode",
    label: "OpenCode",
    lightSrc: opencodeLightIcon,
    darkSrc: opencodeDarkIcon,
  },
};

export function providerIconDefinition(
  providerId: string | null | undefined,
): ProviderIconDefinition | null {
  if (!providerId) return null;
  return providerIconDefinitions[providerId as ProviderId] ?? null;
}

export function supportedProviderIconDefinitions(): readonly ProviderIconDefinition[] {
  return Object.values(providerIconDefinitions);
}
