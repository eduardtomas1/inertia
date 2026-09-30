// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCodexMetadata } from "../../src/server/codex-metadata";
import { validateProviderModels } from "../../src/server/provider/metadata";
import { ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

// Public model fields observed in the Codex 0.159.0 catalog on 2026-09-29.
// Keep the provider identifier and advertised options intact across discovery
// and both App Server launch paths, without substituting an older model.
const solModel = {
  id: "gpt-6.1-sol",
  model: "gpt-6.1-sol",
  displayName: "GPT-6.1-Sol",
  description: "Latest workhorse model for coding and everyday work.",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
    { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
    { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
    { reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" },
  ],
  defaultReasoningEffort: "low",
  inputModalities: ["text", "image"],
  serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
  defaultServiceTier: null,
  isDefault: true,
};

describe("Codex 0.159.0 model catalog", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it.each([
    { interactionMode: "build" as const, reasoningEffort: "max", sessionId: undefined },
    { interactionMode: "plan" as const, reasoningEffort: "ultra", sessionId: "thread-sol-existing" },
  ])("discovers GPT-6.1-Sol and forwards $reasoningEffort reasoning in $interactionMode mode", async ({ interactionMode, reasoningEffort, sessionId }) => {
    const root = portableFixtureRoot("Codex Sol model");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let threadId = "thread-sol-new";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-model-fixture/0.159.0" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [${JSON.stringify(solModel)}], nextCursor: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: message.params.model, serviceTier: null } });
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn-sol", status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId, turn } });
    send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
  }
});
`);

    const metadata = await readCodexMetadata(command, {}, root, 6_000, ["models"]);
    const models = validateProviderModels(metadata.models);
    expect(models).toEqual([expect.objectContaining({
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      isDefault: true,
      inputModalities: ["text", "image"],
      defaultReasoningEffort: "low",
      fastMode: expect.objectContaining({ providerValue: "priority", label: "Fast", isDefault: false }),
    })]);
    expect(models[0]?.reasoningOptions.map(({ value }) => value))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(models[0]?.reasoningOptions.map(({ label }) => label))
      .toEqual(["Low", "Medium", "High", "Xhigh", "Max", "Ultra"]);
    expect(models[0]?.reasoningOptions.at(-1)?.description)
      .toBe("Maximum reasoning with automatic task delegation");
    expect(models[0]?.reasoningOptions.some(({ value }) => value === reasoningEffort)).toBe(true);

    const manager = ProviderManager.createForTests({ commands: { codex: command } });
    managers.push(manager);
    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `conversation-sol-${interactionMode}`,
      cwd: root,
      prompt: "Use the selected Sol model and reasoning effort",
      model: models[0]!.id,
      reasoningEffort,
      interactionMode,
      access: "full",
      ...(sessionId ? { sessionId } : {}),
    }))).resolves.toMatchObject({ status: "completed" });

    const messages = readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages.find(({ method }) => method === (sessionId ? "thread/resume" : "thread/start")))
      .toMatchObject({ params: { model: "gpt-6.1-sol", effort: reasoningEffort } });
    const turn = messages.find(({ method }) => method === "turn/start");
    expect(turn).toMatchObject({ params: { model: "gpt-6.1-sol", effort: reasoningEffort } });
    if (interactionMode === "plan") {
      expect(turn).toMatchObject({ params: { collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-6.1-sol", reasoning_effort: "ultra" },
      } } });
    }
  });
});
