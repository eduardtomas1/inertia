import { describe, expect, it } from "vitest";

import {
  codexModelProviderLaunchArguments,
  codexModelProviderThreadConfig,
} from "../../src/server/codex/model-provider-config";
import { validateCodexModelProvider } from "../../src/server/codex/app-server-config";
import { providerProcessInvocation } from "../../src/server/provider/process";

const provider = {
  kind: "codex-responses" as const,
  providerId: "inertia_custom_openai",
  displayName: "OpenAI API key",
  baseUrl: "https://api.openai.com/v1",
  credentialEnvironmentKey: "INERTIA_CODEX_BACKEND_TOKEN",
};

describe("Codex model provider thread configuration", () => {
  it("keeps the backend token out of tool shells while keeping the person's exclusions", () => {
    expect(codexModelProviderThreadConfig(provider, {
      config: { shell_environment_policy: { exclude: ["AWS_*", "INERTIA_CODEX_BACKEND_TOKEN", 7] } },
    })).toEqual({
      "model_providers.inertia_custom_openai": {
        name: "OpenAI API key",
        base_url: "https://api.openai.com/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        env_key: "INERTIA_CODEX_BACKEND_TOKEN",
      },
      "shell_environment_policy.ignore_default_excludes": false,
      "shell_environment_policy.exclude": ["AWS_*", "INERTIA_CODEX_BACKEND_TOKEN"],
    });
  });

  it("relies on the default token exclusion when the person's policy uses filters", () => {
    const config = codexModelProviderThreadConfig(provider, {
      config: { shell_environment_policy: { filters: [{ exclude: ["AWS_*"] }] } },
    });
    expect(config["shell_environment_policy.ignore_default_excludes"]).toBe(false);
    expect(config).not.toHaveProperty("shell_environment_policy.exclude");
  });

  it("adds no shell policy for a provider without a credential", () => {
    expect(codexModelProviderThreadConfig({ ...provider, credentialEnvironmentKey: null }, null))
      .toEqual({
        "model_providers.inertia_custom_openai": {
          name: "OpenAI API key",
          base_url: "https://api.openai.com/v1",
          wire_api: "responses",
          requires_openai_auth: false,
        },
      });
  });

  it("configures the provider at launch so Codex admits the chat's saved provider", () => {
    const launch = codexModelProviderLaunchArguments({
      ...provider,
      displayName: "Team \"gateway\" (prod)",
    });

    expect(launch).toEqual([
      "-c", "model_provider=inertia_custom_openai",
      "-c", "model_providers.inertia_custom_openai.name=inertia_custom_openai",
      "-c", "model_providers.inertia_custom_openai.base_url=https://api.openai.com/v1",
      "-c", "model_providers.inertia_custom_openai.wire_api=responses",
      "-c", "model_providers.inertia_custom_openai.requires_openai_auth=false",
      "-c", "model_providers.inertia_custom_openai.env_key=INERTIA_CODEX_BACKEND_TOKEN",
    ]);
    expect(() => providerProcessInvocation(
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd",
      ["app-server", ...launch],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    )).not.toThrow();
  });

  it.each(["123", "-1", "1e5", "true", "false", "inf", "nan"])(
    "refuses the provider id %s, which Codex would read as a non-string launch value",
    (providerId) => {
      expect(() => validateCodexModelProvider({
        environment: { INERTIA_CODEX_BACKEND_TOKEN: "token" },
        modelProvider: { ...provider, providerId },
      })).toThrow("The Codex Responses backend configuration is invalid.");
    },
  );

  it.each(["custom", "fixture-gateway", "inertia_custom_openai", "info", "nan_gateway"])(
    "accepts the provider id %s",
    (providerId) => {
      expect(validateCodexModelProvider({
        environment: { INERTIA_CODEX_BACKEND_TOKEN: "token" },
        modelProvider: { ...provider, providerId },
      })).toMatchObject({ providerId });
    },
  );
});
