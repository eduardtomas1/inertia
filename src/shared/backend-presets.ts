import {
  KIMI_CODING_BASE_URL,
  KIMI_CODING_MODELS,
  type ClaudeInternalTierId,
} from "./claude-backend-profiles";
import type {
  BackendAuthenticationMode,
  KnownHarnessId,
  ModelBackendProtocol,
} from "./model-routing";
import type { ProviderId } from "./provider";

export const BACKEND_PRESET_IDS = [
  "anthropic-api-key",
  "openai-api-key",
  "kimi-code",
] as const;

export type BackendPresetId = (typeof BACKEND_PRESET_IDS)[number];

export const API_KEY_BACKEND_PRESET_IDS = [
  "anthropic-api-key",
  "openai-api-key",
] as const;

export type ApiKeyBackendPresetId = (typeof API_KEY_BACKEND_PRESET_IDS)[number];

export interface BackendPresetModel {
  readonly id: string;
  readonly displayName: string;
}

export interface BackendPresetDefinition {
  readonly harnessId: KnownHarnessId;
  readonly protocol: ModelBackendProtocol;
  readonly authenticationMode: BackendAuthenticationMode;
  readonly baseUrl: string;
  readonly displayName: string;
  readonly providerId: ProviderId;
  readonly defaultModels: readonly BackendPresetModel[];
}

export const ANTHROPIC_API_KEY_TIER_MODEL_IDS: Readonly<Record<ClaudeInternalTierId, string>> =
  Object.freeze({
    fable: "claude-fable-5-1",
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-5-5",
  });

const ANTHROPIC_TIER_DISPLAY_NAMES: Readonly<Record<ClaudeInternalTierId, string>> = {
  fable: "Claude Fable 5.1",
  opus: "Claude Opus 5.5",
  sonnet: "Claude Sonnet 5.5",
  haiku: "Claude Haiku 5.5",
};

function presetModels(models: readonly BackendPresetModel[]): readonly BackendPresetModel[] {
  return Object.freeze(models.map(({ id, displayName }) => Object.freeze({ id, displayName })));
}

export const BACKEND_PRESETS: Readonly<Record<BackendPresetId, BackendPresetDefinition>> =
  Object.freeze({
    "anthropic-api-key": Object.freeze({
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      baseUrl: "https://api.anthropic.com",
      displayName: "Anthropic API key",
      providerId: "claude",
      defaultModels: presetModels(
        (Object.keys(ANTHROPIC_API_KEY_TIER_MODEL_IDS) as ClaudeInternalTierId[]).map((tier) => ({
          id: ANTHROPIC_API_KEY_TIER_MODEL_IDS[tier],
          displayName: ANTHROPIC_TIER_DISPLAY_NAMES[tier],
        })),
      ),
    }),
    "openai-api-key": Object.freeze({
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      baseUrl: "https://api.openai.com/v1",
      displayName: "OpenAI API key",
      providerId: "codex",
      defaultModels: presetModels([{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }]),
    }),
    "kimi-code": Object.freeze({
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      baseUrl: KIMI_CODING_BASE_URL,
      displayName: "Kimi",
      providerId: "kimi",
      defaultModels: presetModels(KIMI_CODING_MODELS),
    }),
  });

export function isBackendPresetId(value: unknown): value is BackendPresetId {
  return typeof value === "string"
    && (BACKEND_PRESET_IDS as readonly string[]).includes(value);
}

export function isApiKeyBackendPresetId(value: unknown): value is ApiKeyBackendPresetId {
  return typeof value === "string"
    && (API_KEY_BACKEND_PRESET_IDS as readonly string[]).includes(value);
}

export function backendPresetDefinition(preset: BackendPresetId): BackendPresetDefinition {
  if (!isBackendPresetId(preset)) {
    throw new Error("The backend preset is not in the catalogue.");
  }
  return BACKEND_PRESETS[preset];
}

export function normalizeBackendBaseUrl(
  protocol: ModelBackendProtocol,
  value: string,
): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("The backend URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Backend URLs must start with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Backend URLs cannot contain a user name or password.");
  }
  if (url.search || url.hash || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("Backend URLs cannot contain a query string or fragment.");
  }
  let path = url.pathname.replace(/\/+$/u, "");
  if (protocol === "anthropic-messages") {
    path = path.replace(/\/v1$/u, "");
  } else if (protocol === "openai-responses" && !path.endsWith("/v1")) {
    path = `${path}/v1`;
  }
  return `${url.protocol}//${url.host}${path}`;
}
