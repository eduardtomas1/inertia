import {
  claudeCompatibleBackendProfileSchema,
  validateKimiClaudeModelSelection,
  type ClaudeCompatibleBackendProfile,
} from "../../../shared/claude-backend-profiles";
import type { ModelSelection } from "../../../shared/model-routing";
import type { ProviderInfo } from "../../../shared/contracts";
import type { ProviderManagerOptions } from "../../provider/contracts";
import {
  claudeBackendProfileRegistrations,
  createClaudeBackendLaunchResolver,
} from "./claude-compatible-adapter";

export interface KimiClaudeRuntimeOptions {
  profiles: readonly ClaudeCompatibleBackendProfile[];
  backendCredentials?: {
    resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
    has(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  };
}

export interface KimiClaudeRuntimeReadiness {
  ready: boolean;
  message: string | null;
}

export interface KimiClaudeRuntimePreset {
  providerManagerOptions: Pick<
    ProviderManagerOptions,
    "backendProfiles" | "backendCompatibilities" | "resolveBackendLaunchOptions"
  >;
  isKimiSelection(selection: ModelSelection): boolean;
  validateSelection(selection: ModelSelection): ModelSelection;
  readiness(
    selection: ModelSelection,
    claudeProvider: ProviderInfo | undefined,
  ): Promise<KimiClaudeRuntimeReadiness | null>;
}

export function createKimiClaudeRuntimePreset(
  options: KimiClaudeRuntimeOptions = { profiles: [] },
): KimiClaudeRuntimePreset {
  const profiles = options.profiles.map((input) => {
    const profile = claudeCompatibleBackendProfileSchema.parse(input);
    if (profile.preset !== "kimi-code") {
      throw new Error("The Kimi runtime preset accepts only verified Kimi profiles.");
    }
    return profile;
  });
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  if (profilesById.size !== profiles.length) {
    throw new Error("Kimi backend profile identifiers must be unique.");
  }
  const registrations = claudeBackendProfileRegistrations(profiles);

  const profileFor = (selection: ModelSelection): ClaudeCompatibleBackendProfile | null =>
    profilesById.get(selection.backendProfileId) ?? null;

  return {
    providerManagerOptions: {
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles,
        resolveSecret: (secretReference, signal) =>
          options.backendCredentials?.resolve(secretReference, signal)
          ?? Promise.resolve(null),
      }),
    },
    isKimiSelection: (selection) => profileFor(selection) !== null,
    validateSelection: (selection) => {
      const profile = profileFor(selection);
      return profile ? validateKimiClaudeModelSelection(profile, selection) : selection;
    },
    readiness: async (selection, claudeProvider) => {
      const profile = profileFor(selection);
      if (!profile) return null;
      if (!profile.enabled) {
        return { ready: false, message: `Model backend '${profile.displayName}' is disabled.` };
      }
      if (
        !claudeProvider
        || claudeProvider.installState !== "installed"
        || !claudeProvider.available
        || !claudeProvider.executable
      ) {
        return {
          ready: false,
          message: "The Claude harness is not installed or could not be started.",
        };
      }
      const secretReference = profile.secretReference;
      let credentialAvailable = false;
      if (secretReference !== null) {
        try {
          credentialAvailable = await options.backendCredentials?.has(secretReference)
            ?? false;
        } catch {
          credentialAvailable = false;
        }
      }
      if (!credentialAvailable || !options.backendCredentials) {
        return {
          ready: false,
          message: `The ${profile.displayName} credential is unavailable.`,
        };
      }
      return { ready: true, message: null };
    },
  };
}
