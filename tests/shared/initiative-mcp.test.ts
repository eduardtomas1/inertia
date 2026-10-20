import { describe, expect, it } from "vitest";

import {
  INITIATIVE_MCP_HARNESSES,
  INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES,
  initiativeMcpCommandProblem,
  initiativeMcpRouteSupported,
  initiativeMcpSecretRedactionValues,
  initiativeMcpSecretSlot,
  initiativeMcpSecretSlotChanges,
  initiativeMcpSecretSlots,
  initiativeMcpSecretValueProblem,
  initiativeMcpServerDestination,
  initiativeMcpServerSchema,
  initiativeMcpServersSchema,
  initiativeMcpUrlProblem,
  isInitiativeMcpCredentialName,
  isInitiativeMcpSecretSlot,
  MIN_INITIATIVE_MCP_SECRET_CHARS,
  MAX_INITIATIVE_MCP_ARGS,
  MAX_INITIATIVE_MCP_SECRETS,
  MAX_INITIATIVE_MCP_SERVERS,
  parseInitiativeMcpSecretStateRequest,
  parseSetInitiativeMcpSecretRequest,
  type InitiativeMcpServer,
} from "../../src/shared/initiative-mcp";
import {
  defaultInitiativePreferences,
  initiativePreferencesPatchSchema,
  initiativePreferencesSchema,
  MAX_INITIATIVE_PREFERENCES_JSON_CHARS,
  parseInitiativePreferences,
} from "../../src/shared/initiatives";
import { CURRENT_KNOWN_HARNESS_IDS } from "../../src/shared/model-routing";
import { INERTIA_HOST_MCP_NAME } from "../../src/server/provider/host-tool-mcp-config";

const INITIATIVE = "11111111-1111-4111-8111-111111111111";
const SERVER_A = "22222222-2222-4222-8222-222222222222";
const SERVER_B = "33333333-3333-4333-8333-333333333333";

function httpServer(overrides: Partial<InitiativeMcpServer> = {}): InitiativeMcpServer {
  return {
    id: SERVER_A,
    name: "tracker",
    enabled: true,
    transport: {
      kind: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", secret: true }, { name: "X-Team", value: "checkout" }],
    },
    ...overrides,
  };
}

function stdioServer(overrides: Partial<InitiativeMcpServer> = {}): InitiativeMcpServer {
  return {
    id: SERVER_B,
    name: "docs_search",
    enabled: true,
    transport: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@example/docs-mcp"],
      env: [{ name: "DOCS_TOKEN", secret: true }, { name: "DOCS_REGION", value: "eu" }],
    },
    ...overrides,
  };
}

function withTransport(transport: InitiativeMcpServer["transport"]): InitiativeMcpServer {
  return { ...httpServer(), transport };
}

describe("initiative MCP server model", () => {
  it("accepts HTTP and stdio servers with plain and secret entries", () => {
    expect(initiativeMcpServersSchema.parse([httpServer(), stdioServer()])).toEqual([httpServer(), stdioServer()]);
    expect(initiativePreferencesSchema.parse({ mcpServers: [httpServer()] }).mcpServers).toEqual([httpServer()]);
    expect(initiativePreferencesSchema.parse({}).mcpServers).toEqual([]);
    expect(initiativePreferencesPatchSchema.safeParse({ mcpServers: [] }).success).toBe(true);
  });

  it("refuses reserved, malformed and duplicate names", () => {
    for (const name of [
      "",
      "a".repeat(65),
      "has space",
      "dotted.name",
      "slash/name",
      "nul\0",
      "line\nbreak",
      INERTIA_HOST_MCP_NAME,
      "inertia",
      "Inertia-tools",
      "INERTIA_x",
      "café",
      "codex_apps",
      "Codex_Apps",
    ]) {
      expect(initiativeMcpServerSchema.safeParse(httpServer({ name })).success, name).toBe(false);
    }
    expect(INERTIA_HOST_MCP_NAME.toLowerCase().startsWith("inertia")).toBe(true);
    expect(initiativeMcpServerSchema.safeParse(httpServer({ name: "a".repeat(64) })).success).toBe(true);
    expect(initiativeMcpServersSchema.safeParse([httpServer(), stdioServer({ name: "TRACKER" })]).success).toBe(false);
    expect(initiativeMcpServersSchema.safeParse([httpServer(), stdioServer({ id: SERVER_A })]).success).toBe(false);
  });

  it("allows https anywhere and plain http only on this computer", () => {
    for (const url of [
      "https://mcp.example.com/mcp",
      "https://mcp.example.com:8443/v1/mcp?team=checkout",
      "http://localhost:3000/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://127.1:3000/mcp",
      "http://[::1]:3000/mcp",
    ]) {
      expect(initiativeMcpUrlProblem(url), url).toBeNull();
    }
    for (const url of [
      "",
      "mcp.example.com",
      "http://mcp.example.com/mcp",
      "http://10.0.0.5/mcp",
      "http://localhost.example.com/mcp",
      "ftp://mcp.example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:password@mcp.example.com/",
      "https://token@mcp.example.com/",
      "https://mcp.example.com/mcp#section",
      "https://mcp.example.com/ mcp",
      "https://mcp.example.com/mcp\r\nX-Injected: 1",
      `https://mcp.example.com/${"a".repeat(2_048)}`,
    ]) {
      expect(initiativeMcpUrlProblem(url), url).not.toBeNull();
    }
  });

  it("allows only an absolute path or a bare program name as a stdio command", () => {
    for (const command of [
      "npx",
      "uvx",
      "python3.12",
      "docs-mcp",
      "/usr/local/bin/docs-mcp",
      "/Applications/Docs Server.app/Contents/MacOS/docs",
      "C:\\Program Files (x86)\\Docs\\docs.exe",
      "D:/tools/docs.exe",
    ]) {
      expect(initiativeMcpCommandProblem(command), command).toBeNull();
    }
    for (const command of [
      "",
      " npx",
      "./server",
      "../server",
      "bin/server",
      ".",
      "..",
      "~/bin/server",
      "\\\\host\\share\\server.exe",
      "npx -y server",
      "server;rm -rf /",
      "server && evil",
      "server | tee",
      "$(evil)",
      "`evil`",
      "%COMSPEC%",
      "\"C:\\Program Files\\server.exe\"",
      "/bin/server\n",
      "/bin/ser\0ver",
      `/${"a".repeat(1_024)}`,
    ]) {
      expect(initiativeMcpCommandProblem(command), JSON.stringify(command)).not.toBeNull();
    }
  });

  it("bounds arguments, entries and values and refuses line breaks everywhere", () => {
    const stdio = stdioServer().transport as Extract<InitiativeMcpServer["transport"], { kind: "stdio" }>;
    expect(initiativeMcpServerSchema.safeParse({
      ...stdioServer(),
      transport: { ...stdio, args: Array.from({ length: MAX_INITIATIVE_MCP_ARGS }, (_, index) => `--a${index}`) },
    }).success).toBe(true);
    for (const transport of [
      { ...stdio, args: Array.from({ length: MAX_INITIATIVE_MCP_ARGS + 1 }, () => "x") },
      { ...stdio, args: ["line\nbreak"] },
      { ...stdio, args: ["carriage\rreturn"] },
      { ...stdio, args: ["nul\0"] },
      { ...stdio, env: [{ name: "1BAD", value: "x" }] },
      { ...stdio, env: [{ name: "INERTIA_HOST_MCP_TOKEN", value: "x" }] },
      // Inertia's own launch credentials are kept from servers, never set by them.
      ...INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES.map((name) => ({ ...stdio, env: [{ name, value: "x" }] })),
      { ...stdio, env: [{ name: "anthropic_api_key", secret: true }] },
      { ...stdio, env: [{ name: "OPENCODE_SERVER_PASSWORD", secret: true }] },
      { ...stdio, env: [{ name: "Token", value: "a" }, { name: "TOKEN", value: "b" }] },
      { ...stdio, env: [{ name: "TOKEN", value: "a\nb" }] },
      { ...stdio, env: [{ name: "TOKEN", value: "x".repeat(4_097) }] },
      { ...stdio, env: [{ name: "TOKEN", secret: false }] },
      { ...stdio, env: [{ name: "TOKEN", value: "x", secret: true }] },
      { ...stdio, env: [{ name: "TOKEN", secretRef: "secret:backend:abc" }] },
      { ...stdio, url: "https://mcp.example.com" },
    ]) {
      expect(initiativeMcpServerSchema.safeParse({ ...stdioServer(), transport }).success, JSON.stringify(transport)).toBe(false);
    }
    const http = httpServer().transport as Extract<InitiativeMcpServer["transport"], { kind: "http" }>;
    for (const transport of [
      { ...http, headers: [{ name: "Host", value: "evil.example.com" }] },
      { ...http, headers: [{ name: "content-length", value: "0" }] },
      { ...http, headers: [{ name: "Mcp-Session-Id", value: "x" }] },
      // Credential headers can only be secret.
      { ...http, headers: [{ name: "Authorization", value: "Bearer abcdefgh12" }] },
      { ...http, headers: [{ name: "proxy-authorization", value: "Basic abcdefgh12" }] },
      { ...http, headers: [{ name: "Cookie", value: "session=abcdefgh12" }] },
      { ...http, headers: [{ name: "Bad Header", value: "x" }] },
      { ...http, headers: [{ name: "X-Token", value: "a\r\nX-Injected: 1" }] },
      { ...http, headers: [{ name: "X-Team", value: "a" }, { name: "x-team", value: "b" }] },
      { ...http, headers: Array.from({ length: 17 }, (_, index) => ({ name: `X-H${index}`, value: "v" })) },
      { ...http, command: "npx" },
      { kind: "sse", url: http.url, headers: [] },
    ]) {
      expect(initiativeMcpServerSchema.safeParse(withTransport(transport as never)).success, JSON.stringify(transport)).toBe(false);
    }
  });

  it("limits servers and secrets per initiative, within the preferences column", () => {
    const servers = Array.from({ length: MAX_INITIATIVE_MCP_SERVERS }, (_, index) => httpServer({
      id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
      name: `server-${index}`,
      transport: {
        kind: "http",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", secret: true }, { name: "X-Key", secret: true }],
      },
    }));
    expect(initiativeMcpSecretSlots(servers)).toHaveLength(MAX_INITIATIVE_MCP_SECRETS);
    expect(initiativeMcpServersSchema.safeParse(servers).success).toBe(true);
    expect(initiativeMcpServersSchema.safeParse([...servers, httpServer({ id: SERVER_B, name: "ninth" })]).success).toBe(false);
    const tooManySecrets = servers.map((server, index) => index === 0
      ? { ...server, transport: { ...server.transport, headers: [...(server.transport as { headers: unknown[] }).headers, { name: "X-Third", secret: true }] } }
      : server);
    expect(initiativeMcpServersSchema.safeParse(tooManySecrets).success).toBe(false);
    // A list too large for the stored preferences column is refused as a whole.
    const large = servers.map((server, index) => ({
      ...server,
      id: `${String(index).padStart(8, "0")}-4444-4444-8444-444444444444`,
      transport: {
        kind: "stdio" as const,
        command: "npx",
        args: Array.from({ length: MAX_INITIATIVE_MCP_ARGS }, () => "a".repeat(2_048)),
        env: [],
      },
    }));
    expect(initiativePreferencesSchema.safeParse({ mcpServers: large }).success).toBe(false);
    expect(JSON.stringify({ mcpServers: large }).length).toBeGreaterThan(MAX_INITIATIVE_PREFERENCES_JSON_CHARS);
  });

  it("salvages other preferences when the stored server list is damaged", () => {
    expect(parseInitiativePreferences(JSON.stringify({
      accessCeiling: "auto-edit",
      mcpServers: [{ ...httpServer(), name: "inertia-evil" }],
    }))).toEqual({ ...defaultInitiativePreferences(), accessCeiling: "auto-edit" });
  });
});

describe("initiative MCP secret slots and identity", () => {
  const httpDestination = initiativeMcpServerDestination(httpServer());
  const stdioDestination = initiativeMcpServerDestination(stdioServer());

  it("derives slots from the entry kind and name, with the server's destination", () => {
    expect(initiativeMcpSecretSlot("header", "Authorization")).toBe("header:authorization");
    expect(initiativeMcpSecretSlot("env", "Docs_Token")).toBe("env:Docs_Token");
    expect(initiativeMcpSecretSlots([httpServer(), stdioServer()])).toEqual([
      { serverId: SERVER_A, slot: "header:authorization", destination: httpDestination },
      { serverId: SERVER_B, slot: "env:DOCS_TOKEN", destination: stdioDestination },
    ]);
    for (const slot of ["header:authorization", "env:DOCS_TOKEN", "header:x-api-key"]) {
      expect(isInitiativeMcpSecretSlot(slot), slot).toBe(true);
    }
    for (const slot of ["header:Authorization", "env:1BAD", "secret:backend:x", "header:", "env:", "auth", 7, null]) {
      expect(isInitiativeMcpSecretSlot(slot), String(slot)).toBe(false);
    }
  });

  it("names a destination by URL, or by command, arguments and plain variables", () => {
    const http = httpServer().transport as Extract<InitiativeMcpServer["transport"], { kind: "http" }>;
    const stdio = stdioServer().transport as Extract<InitiativeMcpServer["transport"], { kind: "stdio" }>;
    // Name, switch and HTTP header values are not part of it.
    expect(initiativeMcpServerDestination(httpServer({ name: "renamed", enabled: false }))).toBe(httpDestination);
    expect(initiativeMcpServerDestination(withTransport({ ...http, headers: [{ name: "X-Team", value: "other" }] }))).toBe(httpDestination);
    for (const transport of [
      { ...http, url: "https://evil.example.com/mcp" },
    ]) {
      expect(initiativeMcpServerDestination(withTransport(transport))).not.toBe(httpDestination);
    }
    for (const transport of [
      { ...stdio, command: "uvx" },
      { ...stdio, args: ["-y", "@evil/mcp"] },
      { ...stdio, env: [...stdio.env, { name: "DOCS_URL", value: "https://evil.example.com" }] },
      { ...stdio, env: [{ name: "DOCS_TOKEN", secret: true as const }, { name: "DOCS_REGION", value: "us" }] },
      { ...stdio, env: [{ name: "DOCS_TOKEN", secret: true as const }] },
    ]) {
      expect(initiativeMcpServerDestination({ transport }), JSON.stringify(transport)).not.toBe(stdioDestination);
    }
    // The order of variables does not matter.
    expect(initiativeMcpServerDestination({ transport: { ...stdio, env: [...stdio.env].reverse() } })).toBe(stdioDestination);
  });

  it("lists the secret slots a change adds and removes, including a moved server's", () => {
    const renamedHeader = httpServer({
      transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Api-Key", secret: true }] },
    });
    expect(initiativeMcpSecretSlotChanges([httpServer(), stdioServer()], [renamedHeader])).toEqual({
      added: [{ serverId: SERVER_A, slot: "header:x-api-key", destination: httpDestination }],
      removed: [
        { serverId: SERVER_A, slot: "header:authorization", destination: httpDestination },
        { serverId: SERVER_B, slot: "env:DOCS_TOKEN", destination: stdioDestination },
      ],
    });
    expect(initiativeMcpSecretSlotChanges([httpServer()], [httpServer({ enabled: false, name: "renamed" })])).toEqual({ added: [], removed: [] });
    // The same server at a new URL keeps its identity but none of its secrets.
    const moved = httpServer({ transport: { ...httpServer().transport, url: "https://evil.example.com/mcp" } as InitiativeMcpServer["transport"] });
    const movedDestination = initiativeMcpServerDestination(moved);
    expect(initiativeMcpSecretSlotChanges([httpServer()], [moved])).toEqual({
      added: [{ serverId: SERVER_A, slot: "header:authorization", destination: movedDestination }],
      removed: [{ serverId: SERVER_A, slot: "header:authorization", destination: httpDestination }],
    });
  });

  it("refuses secrets too short to redact, including after an authorization scheme", () => {
    expect(MIN_INITIATIVE_MCP_SECRET_CHARS).toBe(8);
    for (const value of ["x", "1234567", "Bearer 1234567", "token   abc"]) {
      expect(initiativeMcpSecretValueProblem(value), value).toMatch(/at least 8 characters/u);
    }
    for (const value of ["", "   ", "line\nbreak", "••••••••", "x".repeat(16_385)]) {
      expect(initiativeMcpSecretValueProblem(value), JSON.stringify(value)).not.toBeNull();
    }
    for (const value of ["12345678", "Bearer 12345678", "ghp_abcdefghijklmnop"]) {
      expect(initiativeMcpSecretValueProblem(value), value).toBeNull();
    }
    // Problems never repeat the value.
    expect(initiativeMcpSecretValueProblem("Bearer secret7")).not.toContain("secret7");
    expect(initiativeMcpSecretRedactionValues("Bearer abcdefgh")).toEqual(["Bearer abcdefgh", "abcdefgh"]);
    expect(initiativeMcpSecretRedactionValues("abcdefgh")).toEqual(["abcdefgh"]);
    // Nothing shorter than the minimum is ever listed for redaction.
    expect(initiativeMcpSecretRedactionValues("Bearer abc")).toEqual(["Bearer abc"]);
    expect(initiativeMcpSecretRedactionValues("abc")).toEqual([]);
  });

  it("recognises credential-shaped names", () => {
    for (const name of ["Authorization", "Cookie", "X-Api-Key", "DOCS_TOKEN", "client_secret", "DB_PASSWORD", "apikey"]) {
      expect(isInitiativeMcpCredentialName(name), name).toBe(true);
    }
    for (const name of ["X-Team", "DOCS_REGION", "Accept-Language"]) {
      expect(isInitiativeMcpCredentialName(name), name).toBe(false);
    }
  });

  it("parses the privileged secret requests strictly, with readable value refusals", () => {
    const transport = httpServer().transport;
    const set = { initiativeId: INITIATIVE, serverId: SERVER_A, transport, slot: "header:authorization", value: "Bearer abcdefgh" };
    expect(parseSetInitiativeMcpSecretRequest(set)).toEqual({ ok: true, request: set });
    for (const invalid of [
      { ...set, extra: true },
      { ...set, slot: "header:Authorization" },
      { ...set, initiativeId: "initiative" },
      // The slot must be a secret entry of the named transport.
      { ...set, slot: "header:x-team" },
      { ...set, slot: "env:DOCS_TOKEN" },
      { ...set, transport: { kind: "http", url: "http://evil.example.com", headers: [{ name: "Authorization", secret: true }] } },
      { initiativeId: INITIATIVE, serverId: SERVER_A, slot: "header:authorization", value: "Bearer abcdefgh" },
      null,
      [],
    ]) {
      expect(parseSetInitiativeMcpSecretRequest(invalid), JSON.stringify(invalid)).toEqual({
        ok: false, message: "The MCP secret request is invalid.",
      });
    }
    for (const [value, message] of [
      ["x", "Use a secret of at least 8 characters."],
      ["1234567", "Use a secret of at least 8 characters."],
      ["", "Enter the secret."],
      ["   ", "Enter the secret."],
      ["line\nbreak123", "Enter the secret on one line."],
      ["••••••••", "Enter the secret."],
      ["x".repeat(16_385), "Use a secret of at most 16384 characters."],
    ] as const) {
      expect(parseSetInitiativeMcpSecretRequest({ ...set, value }), JSON.stringify(value)).toEqual({ ok: false, message });
    }
    const state = { initiativeId: INITIATIVE, serverId: SERVER_B, transport: stdioServer().transport, slots: ["env:DOCS_TOKEN"] };
    expect(parseInitiativeMcpSecretStateRequest(state)).toEqual(state);
    expect(parseInitiativeMcpSecretStateRequest({ ...state, slots: [] })).toBeNull();
    expect(parseInitiativeMcpSecretStateRequest({ ...state, slots: ["env:DOCS_TOKEN", "env:DOCS_TOKEN"] })).toBeNull();
    expect(parseInitiativeMcpSecretStateRequest({ ...state, slots: ["env:DOCS_REGION"] })).toBeNull();
    expect(parseInitiativeMcpSecretStateRequest({ ...state, value: "x" })).toBeNull();
    const { transport: _transport, ...withoutTransport } = state;
    expect(parseInitiativeMcpSecretStateRequest(withoutTransport)).toBeNull();
  });

  it("supports exactly the harnesses that take external MCP configuration", () => {
    expect(INITIATIVE_MCP_HARNESSES).toEqual(["codex-app-server", "claude-agent-sdk", "cursor-acp", "kimi-acp", "opencode-sdk"]);
    expect(initiativeMcpRouteSupported("antigravity-cli")).toBe(false);
    for (const harnessId of INITIATIVE_MCP_HARNESSES) {
      expect(CURRENT_KNOWN_HARNESS_IDS).toContain(harnessId);
    }
  });
});
