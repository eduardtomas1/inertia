import type { CodexResponsesHarnessConfiguration } from "../provider/contracts";
import { objectValue, type JsonObject } from "./protocol";

type CodexModelProvider = Pick<
  CodexResponsesHarnessConfiguration,
  "providerId" | "displayName" | "baseUrl" | "credentialEnvironmentKey"
>;

function credentialShellPolicy(
  credentialEnvironmentKey: string,
  effectiveConfig: JsonObject | null,
): JsonObject {
  const policy = objectValue(objectValue(effectiveConfig?.config)?.shell_environment_policy);
  if (policy && Object.hasOwn(policy, "filters")) {
    return { "shell_environment_policy.ignore_default_excludes": false };
  }
  const existing = Array.isArray(policy?.exclude)
    ? policy.exclude.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  return {
    "shell_environment_policy.ignore_default_excludes": false,
    "shell_environment_policy.exclude": [...new Set([...existing, credentialEnvironmentKey])],
  };
}

export function codexModelProviderThreadConfig(
  modelProvider: CodexModelProvider,
  effectiveConfig: JsonObject | null,
): JsonObject {
  return {
    [`model_providers.${modelProvider.providerId}`]: {
      name: modelProvider.displayName,
      base_url: modelProvider.baseUrl,
      wire_api: "responses",
      requires_openai_auth: false,
      ...(modelProvider.credentialEnvironmentKey
        ? { env_key: modelProvider.credentialEnvironmentKey }
        : {}),
    },
    ...(modelProvider.credentialEnvironmentKey
      ? credentialShellPolicy(modelProvider.credentialEnvironmentKey, effectiveConfig)
      : {}),
  };
}
