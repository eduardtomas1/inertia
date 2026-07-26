import {
  CLAUDE_INTERNAL_TIER_IDS,
  claudeHarnessBackendCompatibility,
  claudeCodeModelIdentifier,
  claudeCompatibleBackendProfileSchema,
  kimiModelSupportsContextWindow,
  modelBackendProfileForClaudeProfile,
  nativeAnthropicBackendProfile,
  mappedClaudeEffortLevel,
  resolveClaudeModelRouting,
  type ClaudeCompatibleBackendProfile,
} from "../../../shared/claude-backend-profiles";
import type {
  HarnessBackendCompatibility,
  KnownHarnessId,
  ModelBackendProfile,
} from "../../../shared/model-routing";
import type {
  ProviderBackendLaunchOptions,
  ProviderManagerOptions,
  ProviderRunInput,
} from "../../provider/contracts";
import { safeProviderBackendLabel } from "../../provider/adapters";

const CLAUDE_TIER_ENVIRONMENT_VARIABLES = {
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const;

/**
 * Every variable owned by Claude backend routing. Removing these from a
 * non-native launch prevents an inherited Anthropic, gateway, or cloud
 * configuration from leaking into another profile.
 */
const CLAUDE_BACKEND_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_ENABLE_STREAM_WATCHDOG",
  "ENABLE_TOOL_SEARCH",
] as const;

const SECRET_ENVIRONMENT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export interface ClaudeCompatibleLaunchConfiguration {
  /**
   * Fresh launch-only object. It is never `process.env` and must not be
   * persisted, logged, or returned to the renderer.
   */
  environment: NodeJS.ProcessEnv;
  /** Model value passed to Claude Code, including a documented context hint. */
  modelArgument: string | null;
  /** Removes ephemeral credential material from the parent-owned object. */
  releaseSecrets: () => void;
}

export interface ResolveClaudeCompatibleLaunchInput {
  profile: ClaudeCompatibleBackendProfile;
  baseEnvironment: NodeJS.ProcessEnv;
  selectedModelId?: string | null;
  reasoningEffort?: string | null;
  /**
   * Materialized only by the privileged launch boundary. This value must
   * never be placed back into the profile or included in an error.
   */
  secretValue?: string | null;
}

export interface ClaudeBackendLaunchResolverOptions {
  profiles?:
    | readonly ClaudeCompatibleBackendProfile[]
    | (() => readonly ClaudeCompatibleBackendProfile[]);
  /**
   * Privileged materialization seam. Task 21 supplies the secure-store
   * implementation; Task 19 never persists the returned value.
   */
  resolveSecret?: (
    secretReference: string,
    signal?: AbortSignal,
  ) => string | null | Promise<string | null>;
}

export interface ClaudeBackendProfileRegistrations {
  backendProfiles: readonly ModelBackendProfile[];
  backendCompatibilities: readonly HarnessBackendCompatibility[];
}

export class ClaudeBackendLaunchConfigurationError extends Error {
  readonly code:
    | "profile-disabled"
    | "credential-unavailable"
    | "unexpected-credential"
    | "invalid-profile";

  constructor(code: ClaudeBackendLaunchConfigurationError["code"], message: string) {
    super(message);
    this.name = "ClaudeBackendLaunchConfigurationError";
    this.code = code;
  }
}

function deleteEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): void {
  const normalized = key.toUpperCase();
  for (const candidate of Object.keys(environment)) {
    if (candidate.toUpperCase() === normalized) delete environment[candidate];
  }
}

function setEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  deleteEnvironmentKey(environment, key);
  environment[key] = value;
}

function positiveInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClaudeBackendLaunchConfigurationError(
      "invalid-profile",
      "The backend profile contains an invalid numeric process option.",
    );
  }
  return String(value);
}

function configuredModelArgument(modelId: string): string | null {
  return modelId === "provider-default" ? null : modelId;
}

/**
 * Map one safe profile to one owned Claude process. Native Anthropic is a
 * clone-only fast path to preserve the established Claude SDK behavior.
 * Every non-native profile starts from a scrubbed routing namespace and then
 * receives a complete tier mapping.
 */
export function resolveClaudeCompatibleLaunch(
  input: ResolveClaudeCompatibleLaunchInput,
): ClaudeCompatibleLaunchConfiguration {
  const parsed = claudeCompatibleBackendProfileSchema.safeParse(input.profile);
  if (!parsed.success) {
    throw new ClaudeBackendLaunchConfigurationError(
      "invalid-profile",
      "The Claude backend profile is invalid.",
    );
  }
  const profile = parsed.data;
  const backendName = safeProviderBackendLabel(profile.displayName);
  if (!profile.enabled) {
    throw new ClaudeBackendLaunchConfigurationError(
      "profile-disabled",
      `${backendName} is disabled.`,
    );
  }

  const environment: NodeJS.ProcessEnv = { ...input.baseEnvironment };
  const selectedModelId = input.selectedModelId?.trim() || profile.primaryModelId;

  if (profile.preset === "anthropic") {
    if (input.secretValue) {
      throw new ClaudeBackendLaunchConfigurationError(
        "unexpected-credential",
        "Native Anthropic authentication is owned by the Claude harness.",
      );
    }
    return {
      environment,
      modelArgument: configuredModelArgument(selectedModelId),
      releaseSecrets: () => undefined,
    };
  }

  if (
    profile.preset === "kimi-code"
    && !kimiModelSupportsContextWindow(selectedModelId, profile.contextWindowTokens)
  ) {
    throw new ClaudeBackendLaunchConfigurationError(
      "invalid-profile",
      "The selected Kimi model and context window are not supported by this profile.",
    );
  }

  for (const key of CLAUDE_BACKEND_ENVIRONMENT_KEYS) {
    deleteEnvironmentKey(environment, key);
  }

  const needsSecret = profile.authenticationMode === "api-key"
    || profile.authenticationMode === "bearer-token";
  if (needsSecret && !input.secretValue) {
    throw new ClaudeBackendLaunchConfigurationError(
      "credential-unavailable",
      `The ${backendName} credential is unavailable.`,
    );
  }
  if (!needsSecret && input.secretValue) {
    throw new ClaudeBackendLaunchConfigurationError(
      "unexpected-credential",
      `${backendName} does not accept a credential.`,
    );
  }

  setEnvironmentValue(environment, "ANTHROPIC_BASE_URL", profile.baseUrl!);
  if (profile.authenticationMode === "api-key") {
    setEnvironmentValue(environment, "ANTHROPIC_API_KEY", input.secretValue!);
  } else if (profile.authenticationMode === "bearer-token") {
    setEnvironmentValue(environment, "ANTHROPIC_AUTH_TOKEN", input.secretValue!);
  }

  const routing = resolveClaudeModelRouting(profile, selectedModelId);
  const primaryForClaude = claudeCodeModelIdentifier(profile, routing.primaryModelId);
  setEnvironmentValue(environment, "ANTHROPIC_MODEL", primaryForClaude);
  for (const tier of CLAUDE_INTERNAL_TIER_IDS) {
    setEnvironmentValue(
      environment,
      CLAUDE_TIER_ENVIRONMENT_VARIABLES[tier],
      claudeCodeModelIdentifier(profile, routing.tierModels[tier]),
    );
  }
  setEnvironmentValue(
    environment,
    "CLAUDE_CODE_SUBAGENT_MODEL",
    claudeCodeModelIdentifier(profile, routing.subagentModelId),
  );

  const effort = mappedClaudeEffortLevel(profile, input.reasoningEffort);
  if (effort !== null) {
    setEnvironmentValue(environment, "CLAUDE_CODE_EFFORT_LEVEL", effort);
  }
  if (profile.autoCompactionWindowTokens !== null) {
    setEnvironmentValue(
      environment,
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      positiveInteger(profile.autoCompactionWindowTokens),
    );
  }
  if (profile.autoCompactionThresholdPercent !== null) {
    setEnvironmentValue(
      environment,
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
      positiveInteger(profile.autoCompactionThresholdPercent),
    );
  }
  if (
    profile.runtimeOptions.applyVendorContextTokenOverride
    && profile.contextWindowTokens !== null
  ) {
    setEnvironmentValue(
      environment,
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      positiveInteger(profile.contextWindowTokens),
    );
  }
  if (profile.runtimeOptions.enableToolSearch) {
    setEnvironmentValue(environment, "ENABLE_TOOL_SEARCH", "true");
  }
  if (profile.runtimeOptions.alwaysEnableEffort) {
    setEnvironmentValue(environment, "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "1");
  }
  if (profile.runtimeOptions.enableThirdPartyStreamWatchdog) {
    setEnvironmentValue(environment, "CLAUDE_ENABLE_STREAM_WATCHDOG", "1");
  }

  let released = false;
  return {
    environment,
    modelArgument: primaryForClaude,
    releaseSecrets: () => {
      if (released) return;
      released = true;
      for (const key of SECRET_ENVIRONMENT_KEYS) deleteEnvironmentKey(environment, key);
    },
  };
}

function isClaudeHarness(
  harnessId: KnownHarnessId,
): harnessId is Extract<KnownHarnessId, "claude-agent-sdk" | "claude-cli"> {
  return harnessId === "claude-agent-sdk" || harnessId === "claude-cli";
}

function profileMatchesSafeRoute(
  profile: ClaudeCompatibleBackendProfile,
  input: ProviderRunInput,
): boolean {
  return profile.id === input.backendProfile.id
    && profile.protocol === input.backendProfile.protocol
    && profile.authenticationMode === input.backendProfile.authenticationMode
    && profile.configurationRevision === input.backendProfile.configurationRevision
    && profile.endpointIdentity === input.backendProfile.endpointIdentity
    && input.modelSelection.backendProfileId === profile.id
    && input.modelSelection.backendConfigurationRevision === profile.configurationRevision;
}

function normalizedProfileMap(
  profiles: readonly ClaudeCompatibleBackendProfile[],
): ReadonlyMap<string, ClaudeCompatibleBackendProfile> {
  const result = new Map<string, ClaudeCompatibleBackendProfile>();
  for (const input of [nativeAnthropicBackendProfile(), ...profiles]) {
    const profile = claudeCompatibleBackendProfileSchema.parse(input);
    if (result.has(profile.id)) {
      throw new ClaudeBackendLaunchConfigurationError(
        "invalid-profile",
        "Claude backend profile identifiers must be unique.",
      );
    }
    result.set(profile.id, profile);
  }
  return result;
}

/**
 * Produce the safe registration envelopes consumed by Task 18's generic
 * routing foundation. Full Claude configuration remains in the privileged
 * resolver closure.
 */
export function claudeBackendProfileRegistrations(
  profiles: readonly ClaudeCompatibleBackendProfile[],
  harnessId: Extract<KnownHarnessId, "claude-agent-sdk" | "claude-cli"> = "claude-agent-sdk",
): ClaudeBackendProfileRegistrations {
  const normalized = [...normalizedProfileMap(profiles).values()]
    .filter((profile) => profile.preset !== "anthropic");
  return {
    backendProfiles: normalized.map(modelBackendProfileForClaudeProfile),
    backendCompatibilities: normalized.map((profile) =>
      claudeHarnessBackendCompatibility(profile, harnessId)),
  };
}

/**
 * Build Task 18's process-local launch hook. Non-Claude runs receive a fresh
 * unmodified clone. Claude configuration and secret references never enter
 * ProviderRunInput, SQLite, WebSocket payloads, or renderer snapshots.
 */
export function createClaudeBackendLaunchResolver(
  options: ClaudeBackendLaunchResolverOptions = {},
): NonNullable<ProviderManagerOptions["resolveBackendLaunchOptions"]> {
  const staticProfiles = typeof options.profiles === "function"
    ? null
    : normalizedProfileMap(options.profiles ?? []);
  return (
    input: ProviderRunInput,
    baseEnvironment: NodeJS.ProcessEnv,
    context,
  ): ProviderBackendLaunchOptions | Promise<ProviderBackendLaunchOptions> => {
    if (!isClaudeHarness(input.harnessId)) {
      return { environment: { ...baseEnvironment } };
    }
    const profiles = staticProfiles ?? normalizedProfileMap(
      (options.profiles as () => readonly ClaudeCompatibleBackendProfile[])(),
    );
    const profile = profiles.get(input.backendProfile.id);
    if (!profile || !profileMatchesSafeRoute(profile, input)) {
      const backendName = safeProviderBackendLabel(
        input.modelSelection.backendProfileDisplayName,
      );
      throw new ClaudeBackendLaunchConfigurationError(
        "invalid-profile",
        `${backendName} does not match the resolved Claude harness route.`,
      );
    }

    const buildLaunchOptions = (secretValue: string | null): ProviderBackendLaunchOptions => {
      const launch = resolveClaudeCompatibleLaunch({
        profile,
        baseEnvironment,
        selectedModelId: input.modelSelection.modelId,
        reasoningEffort: input.modelSelection.reasoningEffort,
        secretValue,
      });
      return {
        environment: launch.environment,
        modelArgument: launch.modelArgument,
        releaseAfterStart: launch.releaseSecrets,
      };
    };

    if (profile.secretReference === null) return buildLaunchOptions(null);

    let resolvedSecret: string | null | Promise<string | null>;
    try {
      resolvedSecret = options.resolveSecret?.(
        profile.secretReference,
        context.signal,
      ) ?? null;
    } catch {
      const backendName = safeProviderBackendLabel(profile.displayName);
      throw new ClaudeBackendLaunchConfigurationError(
        "credential-unavailable",
        `The ${backendName} credential could not be read from secure storage.`,
      );
    }
    if (isPromiseLike(resolvedSecret)) {
      return Promise.resolve(resolvedSecret).then(
        buildLaunchOptions,
        () => {
          const backendName = safeProviderBackendLabel(profile.displayName);
          throw new ClaudeBackendLaunchConfigurationError(
            "credential-unavailable",
            `The ${backendName} credential could not be read from secure storage.`,
          );
        },
      );
    }
    return buildLaunchOptions(resolvedSecret);
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}
