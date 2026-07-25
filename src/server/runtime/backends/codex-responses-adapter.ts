import {
  modelBackendProfileSchema,
  type ModelBackendProfile,
} from "../../../shared/model-routing";
import type {
  ProviderBackendLaunchOptions,
  ProviderManagerOptions,
  ProviderRunInput,
} from "../../provider/contracts";
import { safeProviderBackendLabel } from "../../provider/adapters";

const CODEX_CREDENTIAL_ENVIRONMENT_KEY = "INERTIA_CODEX_BACKEND_TOKEN";

export interface CodexResponsesBackendProfile {
  /** Safe profile identity registered with ProviderManager. */
  profile: ModelBackendProfile;
  /** Privileged endpoint configuration; never persisted in a turn snapshot. */
  baseUrl: string;
  /** Opaque secure-store reference, never credential material. */
  secretReference: string | null;
  /** Advanced local-development escape hatch; literal loopback only. */
  allowInsecureLocalhost?: boolean;
}

export interface CodexResponsesBackendLaunchResolverOptions {
  profiles?:
    | readonly CodexResponsesBackendProfile[]
    | (() => readonly CodexResponsesBackendProfile[]);
  resolveSecret?: (
    secretReference: string,
    signal?: AbortSignal,
  ) => string | null | Promise<string | null>;
}

export class CodexResponsesBackendConfigurationError extends Error {
  readonly code:
    | "invalid-profile"
    | "credential-unavailable"
    | "unexpected-credential";

  constructor(
    code: CodexResponsesBackendConfigurationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CodexResponsesBackendConfigurationError";
    this.code = code;
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

function isLiteralLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4
    && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function normalizedBaseUrl(value: string, allowInsecureLocalhost: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexResponsesBackendConfigurationError(
      "invalid-profile",
      "The Codex Responses backend URL is invalid.",
    );
  }
  if (
    (
      url.protocol !== "https:"
      && !(
        url.protocol === "http:"
        && allowInsecureLocalhost
        && isLiteralLoopbackHostname(url.hostname)
      )
    )
    || url.username
    || url.password
    || url.search
    || url.hash
    || value.length > 2_048
  ) {
    throw new CodexResponsesBackendConfigurationError(
      "invalid-profile",
      "The Codex Responses backend must use HTTPS or an explicitly allowed literal loopback URL.",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function normalizedProfiles(
  inputs: readonly CodexResponsesBackendProfile[],
): ReadonlyMap<string, CodexResponsesBackendProfile> {
  const result = new Map<string, CodexResponsesBackendProfile>();
  for (const input of inputs) {
    const profile = modelBackendProfileSchema.parse(input.profile);
    if (
      profile.source !== "custom"
      || profile.protocol !== "openai-responses"
      || profile.endpointIdentity === null
      || profile.authenticationMode === "harness-managed"
    ) {
      throw new CodexResponsesBackendConfigurationError(
        "invalid-profile",
        "Codex custom backends must be explicit OpenAI Responses profiles.",
      );
    }
    const secretReference = input.secretReference?.trim() || null;
    const expectsSecret = profile.authenticationMode === "api-key"
      || profile.authenticationMode === "bearer-token";
    if (
      (expectsSecret && !secretReference)
      || (!expectsSecret && secretReference)
      || (secretReference && !/^secret:[A-Za-z0-9][A-Za-z0-9._:-]{0,192}$/u.test(secretReference))
    ) {
      throw new CodexResponsesBackendConfigurationError(
        expectsSecret ? "credential-unavailable" : "unexpected-credential",
        expectsSecret
          ? `The ${safeProviderBackendLabel(profile.displayName)} credential is unavailable.`
          : `${safeProviderBackendLabel(profile.displayName)} does not accept a credential.`,
      );
    }
    if (result.has(profile.id)) {
      throw new CodexResponsesBackendConfigurationError(
        "invalid-profile",
        "Codex backend profile identifiers must be unique.",
      );
    }
    result.set(profile.id, {
      profile,
      baseUrl: normalizedBaseUrl(
        input.baseUrl,
        input.allowInsecureLocalhost === true,
      ),
      secretReference,
      allowInsecureLocalhost: input.allowInsecureLocalhost === true,
    });
  }
  return result;
}

function profileMatchesRoute(
  configured: ModelBackendProfile,
  input: ProviderRunInput,
): boolean {
  return input.backendProfile.id === configured.id
    && input.backendProfile.protocol === configured.protocol
    && input.backendProfile.source === configured.source
    && input.backendProfile.configurationRevision === configured.configurationRevision
    && input.backendProfile.endpointIdentity === configured.endpointIdentity
    && input.modelSelection.backendProfileId === configured.id
    && input.modelSelection.backendConfigurationRevision
      === configured.configurationRevision;
}

function deleteEnvironmentKey(environment: NodeJS.ProcessEnv, key: string): void {
  const normalized = key.toUpperCase();
  for (const candidate of Object.keys(environment)) {
    if (candidate.toUpperCase() === normalized) delete environment[candidate];
  }
}

function providerConfigId(profile: ModelBackendProfile): string {
  const suffix = profile.id.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48);
  const value = `inertia_${suffix || "backend"}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new CodexResponsesBackendConfigurationError(
      "invalid-profile",
      "The Codex backend profile identifier cannot be routed safely.",
    );
  }
  return value;
}

/**
 * Uses Codex's official custom model-provider configuration while keeping the
 * selected App Server harness. The credential exists only in that owned child
 * environment and never enters the JSON-RPC config payload.
 */
export function createCodexResponsesBackendLaunchResolver(
  options: CodexResponsesBackendLaunchResolverOptions = {},
): NonNullable<ProviderManagerOptions["resolveBackendLaunchOptions"]> {
  const staticProfiles = typeof options.profiles === "function"
    ? null
    : normalizedProfiles(options.profiles ?? []);
  return (
    input: ProviderRunInput,
    baseEnvironment: NodeJS.ProcessEnv,
    context,
  ): ProviderBackendLaunchOptions | Promise<ProviderBackendLaunchOptions> => {
    if (input.harnessId !== "codex-app-server") {
      return { environment: { ...baseEnvironment } };
    }
    if (input.backendProfile.id === "builtin:openai") {
      return { environment: { ...baseEnvironment } };
    }
    const profiles = staticProfiles ?? normalizedProfiles(
      (options.profiles as () => readonly CodexResponsesBackendProfile[])(),
    );
    const configured = profiles.get(input.backendProfile.id);
    if (!configured || !profileMatchesRoute(configured.profile, input)) {
      throw new CodexResponsesBackendConfigurationError(
        "invalid-profile",
        `${safeProviderBackendLabel(input.modelSelection.backendProfileDisplayName)} does not match the resolved Codex harness route.`,
      );
    }
    if (
      configured.allowInsecureLocalhost
      && (
        input.backendCompatibility.provenance !== "probe"
        || input.backendCompatibility.reasonCode !== "responses-probe-verified"
        || input.backendCompatibility.state !== "partially-compatible"
      )
    ) {
      throw new CodexResponsesBackendConfigurationError(
        "invalid-profile",
        "The local Codex Responses backend requires current compatibility evidence.",
      );
    }

    const build = (secretValue: string | null): ProviderBackendLaunchOptions => {
      const environment = { ...baseEnvironment };
      deleteEnvironmentKey(environment, CODEX_CREDENTIAL_ENVIRONMENT_KEY);
      const expectsSecret = configured.profile.authenticationMode === "api-key"
        || configured.profile.authenticationMode === "bearer-token";
      if (expectsSecret && !secretValue?.trim()) {
        throw new CodexResponsesBackendConfigurationError(
          "credential-unavailable",
          `The ${safeProviderBackendLabel(configured.profile.displayName)} credential is unavailable.`,
        );
      }
      if (!expectsSecret && secretValue) {
        throw new CodexResponsesBackendConfigurationError(
          "unexpected-credential",
          `${safeProviderBackendLabel(configured.profile.displayName)} does not accept a credential.`,
        );
      }
      if (secretValue) environment[CODEX_CREDENTIAL_ENVIRONMENT_KEY] = secretValue;
      return {
        environment,
        harnessConfiguration: {
          kind: "codex-responses",
          providerId: providerConfigId(configured.profile),
          displayName: configured.profile.displayName,
          baseUrl: configured.baseUrl,
          credentialEnvironmentKey: secretValue
            ? CODEX_CREDENTIAL_ENVIRONMENT_KEY
            : null,
        },
        releaseAfterStart: () => {
          deleteEnvironmentKey(environment, CODEX_CREDENTIAL_ENVIRONMENT_KEY);
          secretValue = null;
        },
      };
    };

    if (!configured.secretReference) return build(null);
    let resolved: string | null | Promise<string | null>;
    try {
      resolved = options.resolveSecret?.(
        configured.secretReference,
        context.signal,
      ) ?? null;
    } catch {
      throw new CodexResponsesBackendConfigurationError(
        "credential-unavailable",
        `The ${safeProviderBackendLabel(configured.profile.displayName)} credential could not be read from secure storage.`,
      );
    }
    if (!isPromiseLike(resolved)) return build(resolved);
    return Promise.resolve(resolved).then(
      build,
      () => {
        throw new CodexResponsesBackendConfigurationError(
          "credential-unavailable",
          `The ${safeProviderBackendLabel(configured.profile.displayName)} credential could not be read from secure storage.`,
        );
      },
    );
  };
}
