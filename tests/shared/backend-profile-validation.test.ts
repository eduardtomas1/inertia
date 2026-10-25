import { describe, expect, it } from "vitest";

import {
  normalizeBackendBaseUrl,
  validateBackendProfileDraft,
} from "../../src/shared/backend-profile-validation";

const model = (id: string, displayName = id) => ({
  id,
  displayName,
  contextWindowTokens: null,
  reasoningOptions: [],
  capabilities: [],
});

const customDraft = {
  displayName: "Team gateway",
  harnessId: "codex-app-server",
  protocol: "openai-responses",
  authenticationMode: "bearer-token",
  preset: "custom",
  baseUrl: "https://gateway.example.test/v1",
  allowInsecureLocalhost: false,
  models: [model("team-model", "Team model")],
  routing: { mode: "simple", primaryModelId: "team-model" },
  capabilityHints: [],
} as const;

const claudeDraft = {
  ...customDraft,
  harnessId: "claude-agent-sdk",
  protocol: "anthropic-messages",
  authenticationMode: "api-key",
} as const;

describe("validateBackendProfileDraft", () => {
  it("returns no issues for valid custom and preset drafts", () => {
    expect(validateBackendProfileDraft(customDraft)).toEqual([]);
    expect(validateBackendProfileDraft(claudeDraft)).toEqual([]);
    expect(validateBackendProfileDraft({ ...customDraft, allowPrivateNetwork: true })).toEqual([]);
    expect(validateBackendProfileDraft({ preset: "anthropic-api-key" })).toEqual([]);
    expect(validateBackendProfileDraft({
      preset: "openai-api-key",
      displayName: "Work OpenAI",
      harnessId: "codex-app-server",
      baseUrl: "https://api.openai.com",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      models: [model("gpt-6.1-sol", "GPT-6.1 Sol")],
      routing: { mode: "simple", primaryModelId: "gpt-6.1-sol" },
    })).toEqual([]);
  });

  it("names the field and explains an empty name", () => {
    expect(validateBackendProfileDraft({ ...customDraft, displayName: "   " }))
      .toEqual([{ field: "name", message: "Enter a name for this backend." }]);
    expect(validateBackendProfileDraft({ ...customDraft, displayName: undefined }))
      .toEqual([{ field: "name", message: "Enter a name for this backend." }]);
    expect(validateBackendProfileDraft({ ...customDraft, displayName: "x".repeat(201) }))
      .toEqual([{ field: "name", message: "Names can be at most 200 characters." }]);
  });

  it("explains each base URL problem in plain English", () => {
    const issues = (baseUrl: unknown) => validateBackendProfileDraft({ ...customDraft, baseUrl });
    expect(issues("")).toEqual([{ field: "baseUrl", message: "Enter the backend URL." }]);
    expect(issues(undefined)).toEqual([{ field: "baseUrl", message: "Enter the backend URL." }]);
    expect(issues("gateway.example.test")).toEqual([{
      field: "baseUrl",
      message: "Enter a full URL, such as https://gateway.example.com/v1.",
    }]);
    expect(issues("ftp://gateway.example.test/v1")).toEqual([{
      field: "baseUrl",
      message: "Backend URLs must start with http:// or https://.",
    }]);
    expect(issues("https://gateway.example.test/v1?team=1")).toEqual([{
      field: "baseUrl",
      message: "Backend URLs cannot contain a query string.",
    }]);
    expect(issues("https://gateway.example.test/v1?")).toEqual([{
      field: "baseUrl",
      message: "Backend URLs cannot contain a query string.",
    }]);
    expect(issues("https://gateway.example.test/v1#models")).toEqual([{
      field: "baseUrl",
      message: "Backend URLs cannot contain a fragment.",
    }]);
    expect(issues("https://user:pass@gateway.example.test/v1")).toEqual([{
      field: "baseUrl",
      message: "Backend URLs cannot contain a user name or password. Save the key separately.",
    }]);
  });

  it("points at the exact model row for empty and duplicate model fields", () => {
    expect(validateBackendProfileDraft({
      ...customDraft,
      models: [model("team-model", "Team model"), model(" ", "Blank"), model("other", "")],
    })).toEqual([
      { field: "models.1.id", message: "Enter a model ID." },
      { field: "models.2.displayName", message: "Enter a display name for this model." },
    ]);
    expect(validateBackendProfileDraft({
      ...customDraft,
      models: [model("team-model"), model("second"), model("team-model")],
    })).toEqual([{
      field: "models.2.id",
      message: "Model IDs must be unique. 'team-model' is listed more than once.",
    }]);
    expect(validateBackendProfileDraft({ ...customDraft, models: [] }))
      .toEqual([{ field: "models", message: "Add at least one model." }]);
    expect(validateBackendProfileDraft({ ...customDraft, models: undefined }))
      .toEqual([{ field: "models", message: "Add at least one model." }]);
  });

  it("maps context windows and routing to their fields", () => {
    expect(validateBackendProfileDraft({
      ...customDraft,
      models: [{ ...model("team-model"), contextWindowTokens: 100 }],
    })).toEqual([{
      field: "contextWindow",
      message: "Context windows must be at least 8,192 tokens.",
    }]);
    expect(validateBackendProfileDraft({
      ...customDraft,
      models: [{ ...model("team-model"), contextWindowTokens: 1.5 }],
    })).toEqual([{
      field: "contextWindow",
      message: "Enter the context window as a whole number of tokens.",
    }]);
    expect(validateBackendProfileDraft({
      ...customDraft,
      routing: { mode: "simple", primaryModelId: "missing" },
    })).toEqual([{
      field: "models",
      message: "Routing references unknown model 'missing'.",
    }]);
  });

  it("refuses unauthenticated Claude backends but allows unauthenticated Responses gateways", () => {
    expect(validateBackendProfileDraft({ ...claudeDraft, authenticationMode: "none" })).toEqual([{
      field: "authenticationMode",
      message: "Claude-compatible backends need an API key or bearer token. Without one, Claude Code would send your Anthropic account sign-in to this host.",
    }]);
    expect(validateBackendProfileDraft({ ...customDraft, authenticationMode: "none" }))
      .toEqual([]);
    expect(validateBackendProfileDraft({ ...customDraft, authenticationMode: "harness-managed" }))
      .toEqual([{
        field: "authenticationMode",
        message: "Custom backends need an API key, a bearer token, or no authentication.",
      }]);
    expect(validateBackendProfileDraft({ ...customDraft, authenticationMode: "password" }))
      .toEqual([{ field: "authenticationMode", message: "Choose a supported authentication method." }]);
  });

  it("reports protocol and harness mismatches against the protocol field", () => {
    expect(validateBackendProfileDraft({ ...customDraft, protocol: "anthropic-messages" }))
      .toEqual([{
        field: "protocol",
        message: "Anthropic Messages profiles require a Claude harness.",
      }]);
    expect(validateBackendProfileDraft({ ...customDraft, protocol: "smoke-signals" }))
      .toEqual([{ field: "protocol", message: "Choose a supported protocol." }]);
  });

  it("holds preset drafts to the catalogue", () => {
    expect(validateBackendProfileDraft({
      preset: "anthropic-api-key",
      baseUrl: "https://gateway.example.test",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
    })).toEqual([
      { field: "protocol", message: "Anthropic API key uses the Anthropic Messages protocol." },
      { field: "authenticationMode", message: "Anthropic API key uses API key authentication." },
      { field: "baseUrl", message: "Anthropic API key always connects to https://api.anthropic.com." },
    ]);
    expect(validateBackendProfileDraft({ preset: "openai-api-key", harnessId: "claude-agent-sdk" }))
      .toEqual([{ field: "protocol", message: "OpenAI API key runs on the Codex harness." }]);
    expect(validateBackendProfileDraft({ preset: "anthropic-api-key", authenticationMode: "none" }))
      .toEqual([{
        field: "authenticationMode",
        message: "Anthropic API key uses API key authentication.",
      }]);
    expect(validateBackendProfileDraft({
      preset: "anthropic-api-key",
      baseUrl: "https://api.anthropic.com/v1/",
    })).toEqual([]);
    expect(validateBackendProfileDraft({
      preset: "openai-api-key",
      routing: { mode: "simple", primaryModelId: "unlisted" },
    })).toEqual([{ field: "models", message: "Routing references unknown model 'unlisted'." }]);
    expect(validateBackendProfileDraft({
      preset: "openai-api-key",
      models: [model("gpt-6.1-sol")],
      routing: {
        mode: "advanced",
        primaryModelId: "gpt-6.1-sol",
        tierModels: {
          fable: "gpt-6.1-sol",
          opus: "gpt-6.1-sol",
          sonnet: "gpt-6.1-sol",
          haiku: "gpt-6.1-sol",
        },
        subagentModelId: "gpt-6.1-sol",
      },
    })).toEqual([{
      field: "models",
      message: "Advanced tier mappings are available only to Claude harness profiles.",
    }]);
  });

  it("refuses native, Kimi and unknown presets in a draft", () => {
    for (const preset of ["native", "kimi-code", "smoke-signals"]) {
      expect(validateBackendProfileDraft({ ...customDraft, preset })).toEqual([{
        field: "protocol",
        message: "Choose Anthropic API key, OpenAI API key or Custom.",
      }]);
    }
  });

  it("explains values that are not drafts at all", () => {
    expect(validateBackendProfileDraft(null)).toEqual([{
      field: "name",
      message: "The backend settings could not be read.",
    }]);
    expect(validateBackendProfileDraft({ ...customDraft, token: "never" })).toEqual([{
      field: "name",
      message: "The backend settings contain an unsupported field.",
    }]);
  });
});

describe("normalizeBackendBaseUrl", () => {
  it("lets Claude Code append /v1/messages itself", () => {
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://api.anthropic.com"))
      .toBe("https://api.anthropic.com");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://api.anthropic.com/v1"))
      .toBe("https://api.anthropic.com");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://api.anthropic.com/v1///"))
      .toBe("https://api.anthropic.com");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://api.kimi.com/coding/"))
      .toBe("https://api.kimi.com/coding");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://gateway.example.test/anthropic/v1/"))
      .toBe("https://gateway.example.test/anthropic");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://gateway.example.test/v1beta"))
      .toBe("https://gateway.example.test/v1beta");
    expect(normalizeBackendBaseUrl("anthropic-messages", " https://api.anthropic.com/ "))
      .toBe("https://api.anthropic.com");
  });

  it("gives Codex a base that ends in /v1", () => {
    expect(normalizeBackendBaseUrl("openai-responses", "https://api.openai.com"))
      .toBe("https://api.openai.com/v1");
    expect(normalizeBackendBaseUrl("openai-responses", "https://api.openai.com/"))
      .toBe("https://api.openai.com/v1");
    expect(normalizeBackendBaseUrl("openai-responses", "https://api.openai.com/v1/"))
      .toBe("https://api.openai.com/v1");
    expect(normalizeBackendBaseUrl("openai-responses", "https://openrouter.ai/api/v1"))
      .toBe("https://openrouter.ai/api/v1");
    expect(normalizeBackendBaseUrl("openai-responses", "https://gateway.example.test/openai"))
      .toBe("https://gateway.example.test/openai/v1");
  });

  it("preserves scheme, host, port and other paths", () => {
    expect(normalizeBackendBaseUrl("openai-responses", "http://127.0.0.1:8080/proxy/"))
      .toBe("http://127.0.0.1:8080/proxy/v1");
    expect(normalizeBackendBaseUrl("anthropic-messages", "HTTPS://Gateway.Example.Test:8443/Team/V1"))
      .toBe("https://gateway.example.test:8443/Team/V1");
    expect(normalizeBackendBaseUrl("anthropic-messages", "https://gateway.example.test:443/team"))
      .toBe("https://gateway.example.test/team");
    expect(normalizeBackendBaseUrl("kimi-managed", "https://example.test/a/b/"))
      .toBe("https://example.test/a/b");
  });

  it("refuses URLs it cannot normalize safely", () => {
    for (const value of [
      "not a url",
      "ftp://example.test/v1",
      "https://example.test/v1?x=1",
      "https://example.test/v1?",
      "https://example.test/v1#frag",
      "https://user:pass@example.test/v1",
    ]) {
      expect(() => normalizeBackendBaseUrl("openai-responses", value)).toThrow();
    }
  });
});
