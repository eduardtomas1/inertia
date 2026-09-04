// @inertia-test-suite portable
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import { ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe.sequential("Codex provider-native Fast mode", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fixture(
    attestFast: boolean,
    waitForInterrupt = false,
    standardAttestation: "default" | "legacy-null" | "priority" = "default",
  ): {
    root: string;
    capturePath: string;
    manager: ProviderManager;
  } {
    const root = portableFixtureRoot("Codex Fast mode");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    const standardAttestationValue = standardAttestation === "legacy-null"
      ? null
      : standardAttestation;
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const waitForInterrupt = ${String(waitForInterrupt)};
let threadId = "thread-fast";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.INERTIA_FAST_CAPTURE, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    return send({ id: message.id, result: { userAgent: "fast-fixture" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: {
      thread: { id: threadId },
      cwd: process.cwd(),
      model: "model-a",
      serviceTier: message.params.serviceTier === null
        ? ${JSON.stringify(standardAttestationValue)}
        : ${attestFast ? "message.params.serviceTier ?? null" : "null"},
    } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: {
      turn: { id: "turn-fast", status: "inProgress", items: [], error: null },
    } });
    send({ method: "turn/started", params: {
      threadId,
      turn: { id: "turn-fast", status: "inProgress", items: [], error: null },
    } });
    if (!waitForInterrupt) setTimeout(() => {
      send({ method: "turn/completed", params: {
        threadId,
        turn: { id: "turn-fast", status: "completed", items: [], error: null },
      } });
    }, 5);
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: "turn-fast", status: "interrupted", items: [], error: null },
    } });
  }
});
`);
    const manager = ProviderManager.createForTests({
      commands: { codex: command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: { ...environment, INERTIA_FAST_CAPTURE: capturePath },
      }),
    });
    managers.push(manager);
    return { root, capturePath, manager };
  }

  function messages(capturePath: string): Array<Record<string, unknown>> {
    return readFileSync(capturePath, "utf8").trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function input(root: string) {
    return nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-fast",
      cwd: root,
      prompt: "Use the requested response speed",
      model: "model-a",
      interactionMode: "build",
      access: "full",
    });
  }

  it("forwards and verifies the advertised Fast service tier", async () => {
    const fake = fixture(true);
    const base = input(fake.root);
    const selection = withModelSelectionFastMode(
      base.modelSelection,
      "priority",
    );
    await expect(fake.manager.run({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "thread/start"))
      .toMatchObject({ params: { serviceTier: "priority" } });
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: "priority" } });
  });

  it("fails closed before turn start when Codex omits Fast attestation", async () => {
    const fake = fixture(false);
    const base = input(fake.root);
    const selection = withModelSelectionFastMode(
      base.modelSelection,
      "priority",
    );
    await expect(fake.manager.run({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "did not apply the requested response speed",
      ),
    });
    expect(messages(fake.capturePath).some(
      ({ method }) => method === "turn/start",
    )).toBe(false);
  });

  it("accepts App Server's default attestation for explicit Standard", async () => {
    const fake = fixture(true);
    await expect(fake.manager.run({
      ...input(fake.root),
      supportedFastMode: "priority",
    })).resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "thread/start"))
      .toMatchObject({ params: { serviceTier: null } });
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: null } });
  });

  it("continues accepting legacy null attestation for explicit Standard", async () => {
    const fake = fixture(true, false, "legacy-null");
    await expect(fake.manager.run({
      ...input(fake.root),
      supportedFastMode: "priority",
    })).resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "thread/start"))
      .toMatchObject({ params: { serviceTier: null } });
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: null } });
  });

  it("fails closed when Codex keeps a Standard request on provider-default Fast", async () => {
    const fake = fixture(true, false, "priority");
    await expect(fake.manager.run({
      ...input(fake.root),
      supportedFastMode: "priority",
    })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "did not apply the requested response speed",
      ),
    });
    expect(messages(fake.capturePath).some(
      ({ method }) => method === "turn/start",
    )).toBe(false);
  });

  it("explicitly resets a resumed Fast session to Standard", async () => {
    const fake = fixture(true);
    await expect(fake.manager.run({
      ...input(fake.root),
      supportedFastMode: "priority",
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "thread/resume"))
      .toMatchObject({ params: { serviceTier: null } });
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: null } });
  });

  it("keeps Standard explicit when resuming without a speed transition", async () => {
    const fake = fixture(true);
    await expect(fake.manager.run({
      ...input(fake.root),
      supportedFastMode: "priority",
      sessionId: "thread-standard",
    })).resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "thread/resume"))
      .toMatchObject({ params: { serviceTier: null } });
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: null } });
  });

  it("omits service-tier fields and attestation for unsupported routes", async () => {
    const fake = fixture(true);
    await expect(fake.manager.run(input(fake.root)))
      .resolves.toMatchObject({ status: "completed" });

    const captured = messages(fake.capturePath);
    const opened = captured.find(({ method }) => method === "thread/start") as {
      params?: Record<string, unknown>;
    };
    const started = captured.find(({ method }) => method === "turn/start") as {
      params?: Record<string, unknown>;
    };
    expect(opened.params).not.toHaveProperty("serviceTier");
    expect(started.params).not.toHaveProperty("serviceTier");
  });

  it("cancels a Fast turn through the unchanged interrupt transport", async () => {
    const fake = fixture(true, true);
    const base = input(fake.root);
    const selection = withModelSelectionFastMode(
      base.modelSelection,
      "priority",
    );
    let cancelled = false;
    const result = fake.manager.run({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    }, {
      onStatus: (event) => {
        if (event.status !== "running" || cancelled) return;
        cancelled = fake.manager.cancel(event.conversationId);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelled).toBe(true);
    const captured = messages(fake.capturePath);
    expect(captured.find(({ method }) => method === "turn/start"))
      .toMatchObject({ params: { serviceTier: "priority" } });
    expect(captured.find(({ method }) => method === "turn/interrupt"))
      .toMatchObject({ params: { threadId: "thread-fast", turnId: "turn-fast" } });
  });
});
