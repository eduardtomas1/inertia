import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectGeminiCliAcpSurface } from "../../scripts/provider-drift-gemini-surface.mjs";

const GEMINI_ACP_SOURCE = String.raw`
const AGENT_METHODS = { session_set_model: "session/set_model" };
const z = { literal: (value) => value };
const legacyPlan = { sessionUpdate: z.literal("plan") };
const contextUsage = { sessionUpdate: z.literal("usage_update") };

function buildAvailableModes(isPlanEnabled) {
  const modes = [{
    id: ApprovalMode.DEFAULT,
    name: "Default",
  }];
  if (isPlanEnabled) {
    modes.push({ id: ApprovalMode.PLAN, name: "Plan" });
  }
  return modes;
}

function buildAvailableModels() {
  return { availableModels: [], currentModelId: "auto" };
}

function newSession() {
  const sessionId = "fixture-session";
  const { availableModels, currentModelId } = buildAvailableModels();
  return {
    sessionId,
    modes: {
      availableModes: buildAvailableModes(true),
      currentModeId: ApprovalMode.DEFAULT,
    },
    models: { availableModels, currentModelId },
  };
}

class Agent {
  async unstable_setSessionModel(params) {
    const session = this.sessionManager.getSession(params.sessionId);
    return session.setModel(params.modelId);
  }
}

function promptResponse() {
  return {
    stopReason: "end_turn",
    _meta: {
      quota: {
        token_count: { input_tokens: 1, output_tokens: 2 },
      },
    },
  };
}

const GOOGLE_OAUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const MANUAL_REDIRECT = "https://codeassist.google.com/authcode";
const OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)([^#\r\n]+)?/gm;
function parseDotenv(src) {
  const lines = src.toString().replace(/\r\n?/gm, "\n");
  let match;
  while ((match = LINE.exec(lines)) != null) {
    let value = match[2] || "";
    value = value.trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['\"\\x60])([\\s\\S]*)\\1$/gm, "$2");
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, "\n");
      value = value.replace(/\\r/g, "\r");
    }
  }
}
function geminiHome() {
  return process.env["GEMINI_CLI_HOME"] || os.homedir();
}
function findEnvFile(startDir, isTrusted, ignoreLocalEnv) {
  let currentDir = path.resolve(startDir);
  const candidates = [
    path.join(currentDir, GEMINI_DIR, ".env"),
    path.join(currentDir, ".env"),
    path.join(homedir(), GEMINI_DIR, ".env"),
    path.join(homedir(), ".env"),
  ];
  currentDir = path.dirname(currentDir);
  return { candidates, isTrusted, ignoreLocalEnv };
}
function loadEnvironment(envFileContent, isTrusted) {
  const parsedEnv = dotenv.parse(envFileContent);
  for (const key in parsedEnv) {
    let value = parsedEnv[key];
    if (!isTrusted && !AUTH_ENV_VAR_WHITELIST.includes(key)) continue;
    if (!isTrusted) value = sanitizeEnvVar(value);
    if (!Object.hasOwn(process.env, key)) process.env[key] = value;
  }
}

void AGENT_METHODS;
void legacyPlan;
void contextUsage;
void newSession;
void Agent;
void promptResponse;
void GOOGLE_OAUTH_ENDPOINT;
void OAUTH_CLIENT_ID;
void MANUAL_REDIRECT;
void OAUTH_SCOPE;
void parseDotenv;
void geminiHome;
void findEnvFile;
void loadEnvironment;
`;

const APPROVAL_MODE_SOURCE = `
const ApprovalMode = {};
ApprovalMode["DEFAULT"] = "default";
ApprovalMode["PLAN"] = "plan";
export { ApprovalMode };
`;

interface FixtureOptions {
  bin?: string | Record<string, string>;
  name?: string;
  source?: string;
  sourceLayout?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inertia-gemini-artifacts-"));
  const sourceLayout = options.sourceLayout === true;
  const executable = sourceLayout ? "dist/cli.js" : "bundle/gemini.js";
  const implementation = sourceLayout
    ? "dist/src/acp/acpAgent.js"
    : "bundle/gemini-platform.js";
  const approvalModes = sourceLayout
    ? "dist/src/acp/approvalModes.js"
    : "bundle/chunk-approval-modes.js";
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: options.name ?? "@google/gemini-cli",
    version: "0.58.0-fixture",
    bin: options.bin ?? { gemini: executable },
  })}\n`, "utf8");
  await mkdir(dirname(join(root, executable)), { recursive: true });
  await writeFile(join(root, executable), "export const cli = true;\n", "utf8");
  await mkdir(dirname(join(root, implementation)), { recursive: true });
  await writeFile(join(root, implementation), options.source ?? GEMINI_ACP_SOURCE, "utf8");
  await writeFile(join(root, approvalModes), APPROVAL_MODE_SOURCE, "utf8");
  return root;
}

async function removeFixture(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true });
}

describe("Gemini provider drift artifact inspection", () => {
  it("attests the required surfaces in the current bundled package layout", async () => {
    const root = await createFixture();
    try {
      await expect(inspectGeminiCliAcpSurface(root)).resolves.toEqual({
        filesInspected: 3,
        totalBytes: expect.any(Number),
      });
    } finally {
      await removeFixture(root);
    }
  });

  it("supports a source-style dist layout and string-form package bin", async () => {
    const root = await createFixture({ bin: "dist/cli.js", sourceLayout: true });
    try {
      const result = await inspectGeminiCliAcpSurface(root);
      expect(result.filesInspected).toBe(3);
      expect(result.totalBytes).toBeGreaterThan(0);
    } finally {
      await removeFixture(root);
    }
  });

  it.each([
    ["buildAvailableModels", "buildModelChoices", "session/new modes and models response"],
    ['name: "Plan"', 'name: "Review"', "Default and Plan mode descriptors"],
    ['"session/set_model"', '"session/select_model"', "session/set_model protocol route"],
    ["unstable_setSessionModel", "unstable_selectSessionModel", "Gemini session model setter"],
    ["token_count", "token_total", "prompt quota token metadata"],
    [
      'sessionUpdate: z.literal("plan")',
      'sessionUpdate: z.literal("checklist")',
      'legacy "plan" session update variant',
    ],
    [
      'sessionUpdate: z.literal("usage_update")',
      'sessionUpdate: z.literal("context_update")',
      '"usage_update" session update variant',
    ],
    [
      '"https://accounts.google.com/o/oauth2/v2/auth"',
      '"https://accounts.google.com/signin/oauth"',
      "Google OAuth authorization endpoint",
    ],
    [
      '"681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"',
      '"replacement.apps.googleusercontent.com"',
      "Gemini OAuth client ID",
    ],
    [
      '"https://codeassist.google.com/authcode"',
      '"https://codeassist.google.com/replacement"',
      "Gemini manual OAuth redirect",
    ],
    [
      '"https://www.googleapis.com/auth/userinfo.profile"',
      '"https://www.googleapis.com/auth/userinfo.openid"',
      "Gemini OAuth scope set",
    ],
    [
      'process.env["GEMINI_CLI_HOME"]',
      'process.env["REPLACEMENT_HOME"]',
      "Gemini CLI home override",
    ],
    [
      "(?:export\\s+)?([\\w.-]+)",
      "([A-Z_]+)",
      "dotenv 16 parser grammar",
    ],
    [
      'path.join(currentDir, GEMINI_DIR, ".env")',
      'path.join(currentDir, GEMINI_DIR, ".secrets")',
      "Gemini dotenv file discovery",
    ],
    [
      "AUTH_ENV_VAR_WHITELIST.includes(key)",
      "AUTH_ENV_VAR_WHITELIST.has(key)",
      "Gemini dotenv environment policy",
    ],
  ])("identifies missing %s evidence", async (needle, replacement, expectedDiagnostic) => {
    const root = await createFixture({ source: GEMINI_ACP_SOURCE.replaceAll(needle, replacement) });
    try {
      await expect(inspectGeminiCliAcpSurface(root)).rejects.toThrow(expectedDiagnostic);
    } finally {
      await removeFixture(root);
    }
  });

  it.each([
    ['ApprovalMode["DEFAULT"] = "default";', 'ApprovalMode["DEFAULT"] = "standard";', 'Default mode id "default"'],
    ['ApprovalMode["PLAN"] = "plan";', 'ApprovalMode["PLAN"] = "review";', 'Plan mode id "plan"'],
  ])("identifies missing stable mode ID evidence", async (needle, replacement, diagnostic) => {
    const root = await createFixture();
    try {
      const path = join(root, "bundle", "chunk-approval-modes.js");
      await writeFile(path, APPROVAL_MODE_SOURCE.replace(needle, replacement), "utf8");
      await expect(inspectGeminiCliAcpSurface(root)).rejects.toThrow(diagnostic);
    } finally {
      await removeFixture(root);
    }
  });

  it("rejects a different package identity", async () => {
    const root = await createFixture({ name: "hostile-gemini-wrapper" });
    try {
      await expect(inspectGeminiCliAcpSurface(root)).rejects.toThrow(
        "received a different npm package",
      );
    } finally {
      await removeFixture(root);
    }
  });

  it("rejects an executable path that escapes the package", async () => {
    const root = await createFixture({ bin: { gemini: "../../outside.js" } });
    try {
      await expect(inspectGeminiCliAcpSurface(root)).rejects.toThrow(
        "executable escapes its package root",
      );
    } finally {
      await removeFixture(root);
    }
  });

  it("enforces a per-artifact byte ceiling before reading source", async () => {
    const root = await createFixture();
    try {
      await expect(inspectGeminiCliAcpSurface(root, {
        maxArtifactBytes: 32,
      })).rejects.toThrow("exceeds the 32-byte inspection limit");
    } finally {
      await removeFixture(root);
    }
  });

  it("enforces aggregate byte and artifact-count ceilings", async () => {
    const root = await createFixture();
    try {
      await expect(inspectGeminiCliAcpSurface(root, {
        maxArtifactBytes: 4_096,
        maxTotalBytes: 32,
      })).rejects.toThrow("32-byte aggregate inspection limit");
      await expect(inspectGeminiCliAcpSurface(root, {
        maxFiles: 2,
      })).rejects.toThrow("more than 2 inspectable source artifacts");
    } finally {
      await removeFixture(root);
    }
  });
});
