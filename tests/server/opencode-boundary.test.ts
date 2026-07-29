import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOpenCodeSdkHarness, readOpenCodeSdkModels } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

type BoundaryScenario =
  | "authenticated"
  | "default-authenticated"
  | "too-many-questions"
  | "too-many-options"
  | "malformed-option"
  | "invalid-question-id"
  | "invalid-permission-id";

function readStableCapture<T>(capturePath: string): T {
  let lastError: unknown;
  for (const candidate of [`${capturePath}.next`, capturePath]) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No fixture capture was written to ${capturePath}.`);
}

function boundaryServerSource(
  root: string,
  capturePath: string,
  scenario: BoundaryScenario,
): string {
  return `
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const args = process.argv.slice(2);
const requestedPort = Number(args.find((arg) => arg.startsWith("--port="))?.slice(7));
let port = requestedPort;
const scenario = ${JSON.stringify(scenario)};
const sessionID = "opencode-boundary-session";
let events;
let authorizedRequests = 0;
let unauthorizedRequests = 0;
const secretDigest = crypto.createHash("sha256")
  .update(process.env.OPENCODE_SERVER_PASSWORD || "")
  .digest("hex");
const capturePath = ${JSON.stringify(capturePath)};
const save = () => {
  const nextPath = capturePath + ".next";
  fs.writeFileSync(nextPath, JSON.stringify({ port, requestedPort, authorizedRequests, unauthorizedRequests, secretDigest }));
  try {
    fs.renameSync(nextPath, capturePath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    fs.copyFileSync(nextPath, capturePath);
  }
};
const sendEvent = (event) => events?.write("data: " + JSON.stringify(event) + "\\n\\n");
const session = { id: sessionID, slug: "fixture", projectID: "project", directory: ${JSON.stringify(root)}, title: "Fixture", version: "1.18.9", model: { id: "model-a", providerID: "fake" }, time: { created: Date.now(), updated: Date.now() } };
const model = { id: "model-a", providerID: "fake", api: { id: "fake", url: "http://fake", npm: "fake" }, name: "Model A", capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: true }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 200000, output: 32000 }, status: "active", options: {}, headers: {}, release_date: "2026-01-01" };
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(status === 204 ? undefined : JSON.stringify(value));
};
const server = http.createServer((req, res) => {
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  const expected = "Basic " + Buffer.from(username + ":" + password).toString("base64");
  if (req.headers.authorization !== expected) {
    unauthorizedRequests += 1;
    save();
    return json(res, { error: "unauthorized" }, 401);
  }
  authorizedRequests += 1;
  save();
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/global/health") return json(res, { healthy: true, version: "1.18.9" });
    if (req.method === "GET" && url.pathname === "/provider") return json(res, { all: [{ id: "fake", name: "Fake", source: "config", env: [], options: {}, models: { "model-a": model } }], default: { fake: "model-a" }, connected: ["fake"] });
    if (req.method === "GET" && url.pathname === "/agent") return json(res, []);
    if (req.method === "POST" && url.pathname === "/session") return json(res, session);
    if (req.method === "GET" && url.pathname === "/session/" + sessionID) return json(res, session);
    if (req.method === "GET" && url.pathname === "/event") {
      events = res;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      return res.flushHeaders();
    }
    if (req.method === "POST" && url.pathname.endsWith("/prompt_async")) {
      json(res, undefined, 204);
      return setTimeout(() => {
        if (scenario === "authenticated" || scenario === "default-authenticated") {
          sendEvent({ type: "message.updated", properties: { sessionID, info: { id: "assistant", sessionID, role: "assistant" } } });
          sendEvent({ type: "message.part.updated", properties: { sessionID, part: { id: "text", sessionID, messageID: "assistant", type: "text", text: "Authenticated OpenCode response" } } });
          return sendEvent({ type: "session.idle", properties: { sessionID } });
        }
        const question = { header: "Scope", question: "Which scope?", options: [{ label: "Focused", description: "Only this package" }], custom: true };
        if (scenario === "invalid-permission-id") {
          return sendEvent({ type: "permission.asked", properties: { id: "../permission", sessionID, permission: "bash", patterns: ["npm test"], metadata: {} } });
        }
        const questions = scenario === "too-many-questions"
          ? [question, question, question, question]
          : scenario === "too-many-options"
            ? [{ ...question, options: Array.from({ length: 21 }, (_, index) => ({ label: "Option " + index, description: "Description " + index })) }]
            : scenario === "malformed-option"
              ? [{ ...question, options: [{ label: "Focused", description: 42 }] }]
              : [question];
        const id = scenario === "invalid-question-id" ? "../question" : "question-1";
        sendEvent({ type: "question.asked", properties: { id, sessionID, questions } });
      }, scenario === "default-authenticated" ? 200 : 10);
    }
    return json(res, { error: "not found" }, 404);
  });
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  save();
  console.log("opencode server listening on http://127.0.0.1:" + port);
});
`;
}

describe.sequential("OpenCode owned-server boundary", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("authenticates both metadata discovery and provider runs without exposing the credential", async () => {
    const root = portableFixtureRoot("OpenCode authenticated boundary");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      boundaryServerSource(root, capturePath, "authenticated"),
    );
    const environment = {
      ...process.env,
      OPENCODE_SERVER_USERNAME: "inertia-test",
      OPENCODE_SERVER_PASSWORD: "private-test-password",
    };

    await expect(readOpenCodeSdkModels(command, environment, root))
      .resolves.toEqual([expect.objectContaining({ id: "fake/model-a" })]);

    const manager = new ProviderManager({
      commands: { opencode: command },
      resolveBackendLaunchOptions: (_input, baseEnvironment) => ({
        environment: {
          ...baseEnvironment,
          OPENCODE_SERVER_USERNAME: environment.OPENCODE_SERVER_USERNAME,
          OPENCODE_SERVER_PASSWORD: environment.OPENCODE_SERVER_PASSWORD,
        },
      }),
    }, new AgentHarnessRegistry([createOpenCodeSdkHarness()]));
    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-authenticated",
      cwd: root,
      prompt: "Authenticate",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Authenticated OpenCode response",
    });

    const capture = readStableCapture<{
      authorizedRequests: number;
      unauthorizedRequests: number;
    }>(capturePath);
    expect(capture.authorizedRequests).toBeGreaterThan(0);
    expect(capture.unauthorizedRequests).toBe(0);
    expect(JSON.stringify(capture)).not.toContain("private-test-password");
  });

  it("protects default owned servers with a unique generated credential", async () => {
    const root = portableFixtureRoot("OpenCode generated boundary");
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(
      root,
      "serve",
      boundaryServerSource(root, capturePath, "default-authenticated"),
    );
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const run = (conversationId: string) => manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId,
      cwd: root,
      prompt: "Authenticate",
      interactionMode: "build",
      access: "supervised",
    }));

    const firstRun = run("opencode-generated-1");
    await waitFor("the first generated OpenCode server to listen", async () => {
      try {
        const capture = readStableCapture<{
          port: number;
        }>(capturePath);
        return await loopbackPortIsOpen(capture.port);
      } catch {
        return false;
      }
    });
    const firstListening = readStableCapture<{
      port: number;
      requestedPort: number;
    }>(capturePath);
    expect(firstListening.requestedPort).toBe(0);
    const unauthenticated = await fetch(
      `http://127.0.0.1:${firstListening.port}/global/health`,
    );
    expect(unauthenticated.status).toBe(401);
    const firstResult = await firstRun;
    expect(firstResult).toMatchObject({
      status: "completed",
      text: "Authenticated OpenCode response",
    });
    const firstCapture = readStableCapture<{
      authorizedRequests: number;
      unauthorizedRequests: number;
      secretDigest: string;
    }>(capturePath);
    expect(firstCapture.authorizedRequests).toBeGreaterThan(0);
    expect(firstCapture.unauthorizedRequests).toBe(1);

    const secondResult = await run("opencode-generated-2");
    expect(secondResult).toMatchObject({
      status: "completed",
      text: "Authenticated OpenCode response",
    });
    const secondCapture = readStableCapture<{
      secretDigest: string;
    }>(capturePath);
    expect(secondCapture.secretDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondCapture.secretDigest).not.toBe(firstCapture.secretDigest);
    expect(JSON.stringify([firstResult, secondResult])).not.toMatch(
      /authorization|password|secretDigest/iu,
    );
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it.each([
    ["too-many-questions", "more questions than Inertia can represent safely"],
    ["too-many-options", "too many options for question 1"],
    ["malformed-option", "invalid option 1 for question 1"],
    ["invalid-question-id", "invalid question request ID"],
    ["invalid-permission-id", "invalid permission request ID"],
  ] as const)("fails closed and cleans up a %s payload", async (scenario, error) => {
    const root = portableFixtureRoot(`OpenCode ${scenario}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", boundaryServerSource(root, capturePath, scenario));
    const manager = new ProviderManager(
      { commands: { opencode: command } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    let inputRequests = 0;

    await expect(manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: `opencode-${scenario}`,
      cwd: root,
      prompt: "Ask",
      interactionMode: "build",
      access: "supervised",
    }), {
      onInput: () => {
        inputRequests += 1;
      },
    })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(error),
    });

    expect(inputRequests).toBe(0);
    const capture = readStableCapture<{ port: number }>(capturePath);
    await waitFor(
      `the ${scenario} OpenCode server to close`,
      async () => !(await loopbackPortIsOpen(capture.port)),
    );
    expect(manager.activeConversationIds()).toEqual([]);
  });
});
