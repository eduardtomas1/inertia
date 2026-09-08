import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requireAcpInitializeHandshake } from "../../scripts/provider-drift-process.mjs";
import { stageKimiTerminalAuthPolicy } from "../../scripts/provider-drift-staging.mjs";

describe("secret-free Kimi terminal-auth canary", () => {
  it.each([false, true])("stages the production policy and checks the negotiated contract without running login (invalid=%s)", async (invalid) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-kimi-auth-canary-"));
    const capture = join(root, "requests.jsonl");
    let cleanupSafe = true;
    try {
      const kimiTerminalAuthPolicyPath = await stageKimiTerminalAuthPolicy(resolve("scripts"), root);
      const invocation = requireAcpInitializeHandshake(process.execPath, ["--input-type=commonjs", "-e", `
const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (message.method !== "initialize") throw new Error("Canaries may not authenticate or create sessions.");
  if (message.params.clientCapabilities.auth?.terminal !== true) throw new Error("Terminal support was not negotiated.");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "fixture" },
    authMethods: [{ id: "login", type: "terminal", name: "Kimi login", args: ["--login"],
      env: ${invalid ? '{ NODE_OPTIONS: "private-do-not-print" }' : '{}'} }],
  } }) + "\\n");
});
`], { cwd: root, environment: process.env }, {
        expectedAgent: "Kimi Code CLI", requireLoadSession: false, kimiTerminalAuthPolicyPath,
      }).catch((error: unknown) => {
        cleanupSafe = !(error && typeof error === "object"
          && "preserveTemporaryRoot" in error && error.preserveTemporaryRoot === true);
        throw error;
      });
      if (invalid) await expect(invocation).rejects.toThrow(/unsupported or invalid terminal authentication descriptor/);
      else await expect(invocation).resolves.toBeUndefined();
      const requests = readFileSync(capture, "utf8").trim().split("\n")
        .map(line => JSON.parse(line) as { method: string });
      expect(requests.map(({ method }) => method)).toEqual(["initialize"]);
    } finally {
      if (cleanupSafe) rmSync(root, { recursive: true, force: true });
    }
  });
});
