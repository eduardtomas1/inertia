// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import type { ProviderMcpServerInput } from "../../src/server/provider/contracts";
import {
  acpInitiativeMcpServers,
  claudeAllowedInitiativeMcpServers,
  claudeInitiativeMcpServers,
  codexConfiguredMcpServerNames,
  codexInitiativeMcpConfig,
  inheritedLaunchCredentialNames,
  openCodeInitiativeMcpConfig,
  withoutInheritedCredentials,
  withoutNativeNameClashes,
} from "../../src/server/provider/initiative-mcp-config";
import { INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES } from "../../src/shared/initiative-mcp";

const SECRET = "fixture-header-secret-7b1c";
const ENV_SECRET = "fixture-env-secret-91aa";

const http: ProviderMcpServerInput = {
  name: "tracker",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: [
    { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    { name: "X-Team", value: "checkout" },
  ],
};
const stdio: ProviderMcpServerInput = {
  name: "docs_search",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/docs-mcp"],
  env: [{ name: "DOCS_TOKEN", value: ENV_SECRET, secret: true }, { name: "DOCS_REGION", value: "eu" }],
};

describe("initiative MCP provider translations", () => {
  it("adds one dotted Codex override per server with Codex's field names", () => {
    expect(codexInitiativeMcpConfig([http, stdio], new Set())).toEqual({
      value: {
        "mcp_servers.tracker": {
          url: "https://mcp.example.com/mcp",
          http_headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "checkout" },
        },
        "mcp_servers.docs_search": {
          command: "npx",
          args: ["-y", "@example/docs-mcp"],
          env: { DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu" },
        },
      },
      skipped: [],
    });
    // No empty maps: Codex rejects transport fields that do not apply, and
    // an absent field leaves Codex's defaults.
    expect(codexInitiativeMcpConfig([{ ...http, headers: [] }, { ...stdio, env: [] }], new Set()).value).toEqual({
      "mcp_servers.tracker": { url: "https://mcp.example.com/mcp" },
      "mcp_servers.docs_search": { command: "npx", args: ["-y", "@example/docs-mcp"] },
    });
  });

  it("never merges over a Codex server the user configured with the same name", () => {
    const translated = codexInitiativeMcpConfig([http, stdio], new Set(["tracker"]));
    expect(Object.keys(translated.value)).toEqual(["mcp_servers.docs_search"]);
    expect(translated.skipped).toEqual([{ name: "tracker", reason: expect.stringContaining("Codex already has an MCP server named “tracker”") }]);
    expect(JSON.stringify(translated.skipped)).not.toContain(SECRET);
  });

  it("reads the user's Codex server names from config/read", () => {
    expect(codexConfiguredMcpServerNames({ config: { mcp_servers: { docs: { command: "docs" }, search: { url: "http://127.0.0.1:9" } } } }))
      .toEqual(new Set(["docs", "search"]));
    expect(codexConfiguredMcpServerNames({ config: { model: "gpt" } })).toEqual(new Set());
    expect(codexConfiguredMcpServerNames({ config: { mcp_servers: null } })).toEqual(new Set());
    for (const unreadable of [null, "config", {}, { config: null }, { config: { mcp_servers: [] } }, { config: { mcp_servers: "x" } }]) {
      expect(codexConfiguredMcpServerNames(unreadable), JSON.stringify(unreadable)).toBeNull();
    }
  });

  it("builds Claude SDK servers and an allowlist of exactly their names", () => {
    expect(claudeInitiativeMcpServers([http, stdio])).toEqual({
      tracker: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "checkout" } },
      docs_search: { type: "stdio", command: "npx", args: ["-y", "@example/docs-mcp"], env: { DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu" } },
    });
    expect(claudeAllowedInitiativeMcpServers([http, stdio])).toEqual([{ serverName: "tracker" }, { serverName: "docs_search" }]);
  });

  it("builds ACP McpServer entries and leaves HTTP out when the agent cannot use it", () => {
    expect(acpInitiativeMcpServers("Cursor", [http, stdio], true)).toEqual({
      value: [
        {
          type: "http",
          name: "tracker",
          url: "https://mcp.example.com/mcp",
          headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }, { name: "X-Team", value: "checkout" }],
        },
        {
          name: "docs_search",
          command: "npx",
          args: ["-y", "@example/docs-mcp"],
          env: [{ name: "DOCS_TOKEN", value: ENV_SECRET }, { name: "DOCS_REGION", value: "eu" }],
        },
      ],
      skipped: [],
    });
    const stdioOnly = acpInitiativeMcpServers("Kimi Code", [http, stdio], false);
    expect(stdioOnly.value.map(({ name }) => name)).toEqual(["docs_search"]);
    expect(stdioOnly.skipped).toEqual([{ name: "tracker", reason: "Kimi Code did not report support for HTTP MCP servers." }]);
    // The provider-neutral secret marker never reaches the native request.
    expect(JSON.stringify(acpInitiativeMcpServers("Cursor", [http, stdio], true).value)).not.toContain("secret\"");
  });

  it("builds OpenCode remote and local configurations with OAuth discovery off", () => {
    expect(openCodeInitiativeMcpConfig(http)).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      enabled: true,
      headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "checkout" },
      oauth: false,
      timeout: 30_000,
    });
    expect(openCodeInitiativeMcpConfig(stdio)).toEqual({
      type: "local",
      command: ["npx", "-y", "@example/docs-mcp"],
      environment: { DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu" },
      enabled: true,
      timeout: 30_000,
    });
  });

  it("leaves out servers whose names the provider already uses, with one rule for Codex and OpenCode", () => {
    const clashes = withoutNativeNameClashes("OpenCode", [http, stdio], new Set(["docs_search", "inertia-chat-manager"]));
    expect(clashes.value).toEqual([http]);
    expect(clashes.skipped).toEqual([{
      name: "docs_search",
      reason: "OpenCode already has an MCP server named “docs_search”, which Inertia leaves as it is. Rename the initiative's server to use both.",
    }]);
    const codex = codexInitiativeMcpConfig([http, stdio], new Set(["tracker"]));
    expect(Object.keys(codex.value)).toEqual(["mcp_servers.docs_search"]);
    expect(codex.skipped[0]!.reason).toMatch(/^Codex already has an MCP server named “tracker”/u);
  });

  it("blanks every launch credential a provider's stdio server would inherit, keeping the server's own", () => {
    const names = inheritedLaunchCredentialNames({
      PATH: "/usr/bin",
      HOME: "/home/user",
      OPENAI_API_KEY: "sk-launch-credential",
      GITHUB_TOKEN: "ghp_launch_credential",
      EMPTY_TOKEN: "",
    });
    expect(names).toEqual(expect.arrayContaining([...INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES, "OPENAI_API_KEY", "GITHUB_TOKEN"]));
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("EMPTY_TOKEN");
    const ownToken = { ...stdio, env: [...stdio.env, { name: "github_token", value: "the server's own" }] } as ProviderMcpServerInput;
    const [httpOut, stdioOut] = withoutInheritedCredentials([http, ownToken], names);
    // HTTP servers run elsewhere and inherit nothing.
    expect(httpOut).toBe(http);
    const env = (stdioOut as Extract<ProviderMcpServerInput, { transport: "stdio" }>).env;
    expect(env.slice(-3)).toEqual([...stdio.env, { name: "github_token", value: "the server's own" }]);
    const blanks = env.slice(0, -3);
    expect(blanks.every(({ value }) => value === "")).toBe(true);
    expect(blanks.map(({ name }) => name)).toContain("OPENAI_API_KEY");
    expect(blanks.map(({ name }) => name)).toContain("OPENCODE_SERVER_PASSWORD");
    // A variable the server sets itself is never blanked, whatever its case.
    expect(blanks.map(({ name }) => name)).not.toContain("GITHUB_TOKEN");
  });
});
