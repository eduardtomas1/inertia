import { describe, expect, it } from "vitest";

import { codexModelProviderThreadConfig } from "../../src/server/codex/model-provider-config";

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
});
