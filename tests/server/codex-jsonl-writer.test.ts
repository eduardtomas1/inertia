// @inertia-test-suite portable
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import { CodexJsonLineWriter } from "../../src/server/codex/jsonl-writer";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

describe("Codex JSONL writer", () => {
  it("serializes writes and waits for backpressure to drain", async () => {
    const frames: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        frames.push(chunk.toString("utf8"));
        setImmediate(callback);
      },
    });
    const writer = new CodexJsonLineWriter(stream, 1_024, 4_096);

    await Promise.all([
      writer.write({ id: 1, method: "first" }),
      writer.write({ id: 2, method: "second" }),
      writer.write({ id: 3, method: "third" }),
    ]);

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { id: 1, method: "first" },
      { id: 2, method: "second" },
      { id: 3, method: "third" },
    ]);
  });

  it("rejects oversized frames and a saturated queue", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, _callback) {
        // Hold the active frame to exercise the retained-byte budget.
      },
    });
    const frameBounded = new CodexJsonLineWriter(stream, 16, 1_024);
    await expect(frameBounded.write({ payload: "x".repeat(32) }))
      .rejects.toThrow("frame limit");

    const queueBounded = new CodexJsonLineWriter(stream, 1_024, 32);
    const active = queueBounded.write({ payload: "1234567890" });
    await expect(queueBounded.write({ payload: "1234567890" }))
      .rejects.toThrow("write queue");
    queueBounded.close();
    await expect(active).rejects.toThrow("input stream closed");
  });

  it("rejects active and queued writes when transport closes", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, _callback) {
        // Simulate a provider that stopped reading stdin.
      },
    });
    const writer = new CodexJsonLineWriter(stream, 1_024, 4_096);
    const active = writer.write({ id: 1 });
    const queued = writer.write({ id: 2 });

    writer.close(new Error("stdin closed by provider"));

    await expect(active).rejects.toThrow("stdin closed by provider");
    await expect(queued).rejects.toThrow("stdin closed by provider");
    await expect(writer.write({ id: 3 }))
      .rejects.toThrow("stdin closed by provider");
  });

  it("settles the run and its pending RPC when an async queued write rejects", async () => {
    const root = portableFixtureRoot("codex rejected write");
    try {
      const executable = portableNodeExecutable(root, "codex");
      writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "writer-thread" } } });
  }
});
`);
      const run = startCodexAppServerRun({
        executable,
        environment: process.env,
        cwd: root,
        prompt: "x".repeat(2_000),
        planMode: false,
        access: "full",
        rpcTimeoutMs: 10_000,
        protocolLimits: {
          maxFrameBytes: 1_024,
          maxProtocolBytes: 4_096,
        },
      });

      await expect(run.result).resolves.toMatchObject({
        status: "failed",
        failure: {
          reason: "transport-closed",
          technicalDetail: expect.stringContaining("frame limit"),
        },
      });
    } finally {
      await removePortableFixture(root);
    }
  });
});
