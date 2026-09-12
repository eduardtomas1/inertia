// @inertia-test-suite portable
import type { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoundedClaudeTransport, CLAUDE_TRANSPORT_LIMITS } from "../../src/server/provider/claude-transport";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { MAX_CLAUDE_EVENT_MEDIA_BYTES } from "../../src/server/provider/claude-event-budget";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { claudeSuccessResult, claudeSystem } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("Claude raw stdout boundary", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("rejects an oversized line before forwarding its offending chunk (newline=%s)", async (complete) => {
    const guard = new BoundedClaudeTransport({ maxLineBytes: 16, maxBurstLines: 10, maxBurstBytes: 128 });
    const delivered: Buffer[] = [];
    guard.on("data", (chunk: Buffer) => delivered.push(chunk));
    const failed = once(guard, "error");
    guard.write(Buffer.alloc(12, 0x78));
    guard.write(Buffer.from(`xxxxx${complete ? "\n" : ""}`));
    expect((await failed)[0]).toMatchObject({ message: "Claude transport sent an oversized stdout line." });
    expect(Buffer.concat(delivered)).toEqual(Buffer.alloc(12, 0x78));
  });

  it.each(["\n", "\r", "ignored\n", "{}\r\n"])("accounts SDK-ignored output %j in the line budget", async (line) => {
    const guard = new BoundedClaudeTransport({ maxLineBytes: 16, maxBurstLines: 2, maxBurstBytes: 128 });
    const output = collect(guard);
    const rejected = expect(output).rejects.toThrow("bounded event rate");
    guard.end(line.repeat(3));
    await rejected;
  });

  it("accounts raw bytes and cumulative output even when the SDK would discard every line", async () => {
    vi.useFakeTimers();
    const guard = new BoundedClaudeTransport({ maxLineBytes: 16, maxBurstLines: 10, maxBurstBytes: 8 });
    guard.resume();
    const failed = once(guard, "error");
    for (let index = 0; index < 16; index += 1) {
      guard.write("ignored\n");
      vi.setSystemTime(Date.now() + 60_000);
    }
    guard.write("ignored\n");
    expect((await failed)[0]).toMatchObject({ message: expect.stringContaining("bounded event budget") });
  });

  it("keeps split UTF-8, CRLF and an unterminated final line byte-for-byte", async () => {
    const bytes = Buffer.from('{"text":"😀"}\r\nlast');
    const guard = new BoundedClaudeTransport();
    const output = collect(guard);
    for (const byte of bytes) guard.write(Buffer.from([byte]));
    guard.end();
    expect(await output).toEqual(bytes);
  });

  it("propagates backpressure to the source and resumes without losing bytes", async () => {
    const source = new PassThrough();
    const guard = new BoundedClaudeTransport();
    source.pipe(guard);
    const chunk = Buffer.alloc(16 * 1024, 0x78);
    let written = 0;
    let accepting = true;
    while (accepting && written < 1024 * 1024) {
      accepting = source.write(chunk);
      written += chunk.length;
    }
    expect(accepting).toBe(false);
    expect(written).toBeLessThan(1024 * 1024);
    const output = collect(guard);
    source.end();
    expect(await output).toEqual(Buffer.alloc(written, 0x78));
  });

  it("admits a maximum-size duplicated Read media frame without buffering it in the guard", async () => {
    const bytes = MAX_CLAUDE_EVENT_MEDIA_BYTES;
    const encodedBytes = 4 * Math.ceil(bytes / 3);
    const parts = [
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"read","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"',
      `"}}]}]},"tool_use_result":{"type":"image","file":{"type":"image/png","originalSize":${bytes},"base64":"`,
      '"}}}\n',
    ];
    function* frame(): Generator<Buffer> {
      for (let copy = 0; copy < 2; copy += 1) {
        yield Buffer.from(parts[copy]!);
        let remaining = encodedBytes - 4;
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        while (remaining > 0) {
          const length = Math.min(remaining, chunk.length);
          yield chunk.subarray(0, length);
          remaining -= length;
        }
        yield Buffer.from("AAA=");
      }
      yield Buffer.from(parts[2]!);
    }
    let delivered = 0;
    const guard = Readable.from(frame()).pipe(new BoundedClaudeTransport());
    for await (const chunk of guard) delivered += chunk.length;
    expect(delivered).toBe(encodedBytes * 2 + parts.join("").length);
    expect(delivered).toBeLessThan(CLAUDE_TRANSPORT_LIMITS.maxLineBytes);
  });
});

describe("installed Claude SDK owned transport", () => {
  it.each([false, true])("preserves a valid turn and settles cancellation (%s) through the owned barrier", async (cancel) => {
    const root = portableFixtureRoot("Claude bounded stream success or cancel");
    const child = fakeClaudeChild() as ReturnType<typeof fakeClaudeChild> & { stdin: PassThrough; stdout: PassThrough };
    const input = createInterface({ input: child.stdin });
    let receivedUser = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const terminateProcessTree = vi.fn(async () => {
      child.stdout.end();
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      await cleanup;
      return true;
    });
    const send = (message: unknown): void => { child.stdout.write(`${JSON.stringify(message)}\n`); };
    input.on("line", (line) => {
      const message = JSON.parse(line) as { type: string; request_id: string };
      if (message.type === "control_request") {
        send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
          response: { commands: [], models: [], agents: [], account: {} } } });
      } else if (message.type === "user") {
        receivedUser = true;
        if (cancel) child.stdout.write('{"incomplete":');
        else {
          send(claudeSystem("init"));
          // This remains eligible for the PR's post-parse shortening: the raw
          // boundary must not restore the old 1 MiB hard turn failure.
          send({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
            { type: "tool_result", tool_use_id: "large-build-log", content: "x".repeat(1_500_000) },
          ] } });
          send(claudeSuccessResult("Completed after large log", "completed"));
        }
      }
    });
    const harness = createClaudeAgentSdkHarness({
      spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
      terminateProcessTree,
    });
    const run = harness.start({ input: nativeProviderRunInput({ providerId: "claude", conversationId: "wire-valid",
      cwd: root, prompt: "Synthetic request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true });
    let settled = false;
    void run.result.then(() => { settled = true; });
    try {
      await expect.poll(() => receivedUser).toBe(true);
      if (cancel) run.cancel(true);
      await expect.poll(() => terminateProcessTree.mock.calls.length).toBe(1);
      expect(settled).toBe(false);
      releaseCleanup();
      await expect(run.result).resolves.toMatchObject(cancel
        ? { status: "cancelled" }
        : { status: "completed", text: "Completed after large log" });
      expect(terminateProcessTree).toHaveBeenCalledOnce();
    } finally {
      releaseCleanup(); input.close();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await removePortableFixture(root);
    }
  });

  it.each([
    ["startup", true], ["incomplete", true], ["complete", true], ["ignored", true], ["incomplete", false],
  ] as const)("awaits owned cleanup after %s output (confirmed=%s)", async (kind, cleanupConfirmed) => {
    const root = portableFixtureRoot("Claude bounded installed transport");
    const child = fakeClaudeChild() as ReturnType<typeof fakeClaudeChild> & { stdin: PassThrough; stdout: PassThrough };
    const input = createInterface({ input: child.stdin });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const terminateProcessTree = vi.fn(async () => {
      child.stdout.end();
      Object.assign(child, { exitCode: 1 });
      child.emit("exit", 1, null);
      await cleanup;
      return cleanupConfirmed;
    });
    input.on("line", (line) => {
      const message = JSON.parse(line) as { type: string; request_id: string };
      if (message.type === "control_request") {
        child.stdout.write(`${JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: message.request_id,
          response: { commands: [], models: [], agents: [], account: {} },
        } })}\n`);
      } else if (message.type === "user") {
        child.stdout.write(kind === "ignored"
          ? `${JSON.stringify({ type: "keep_alive" })}\n`.repeat(101)
          : "x".repeat(1025) + (kind === "complete" ? "\n" : ""));
      }
    });
    const harness = createClaudeAgentSdkHarness({
      spawnProcess: vi.fn(() => {
        if (kind === "startup") queueMicrotask(() => child.stdout.write("x".repeat(1025)));
        return child;
      }) as unknown as typeof spawn,
      terminateProcessTree,
      transportLimits: { maxLineBytes: 1024, maxBurstLines: 100, maxBurstBytes: 8192 },
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "wire-overflow", cwd: root,
        prompt: "Synthetic request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });
    let settled = false;
    void run.result.then(() => { settled = true; });
    try {
      await expect.poll(() => terminateProcessTree.mock.calls.length).toBe(1);
      expect(settled).toBe(false);
      releaseCleanup();
      await expect(run.result).resolves.toMatchObject({
        status: "failed",
        ...(cleanupConfirmed
          ? { error: kind === "ignored"
              ? "Claude transport exceeded the bounded event rate for this run."
              : "Claude transport sent an oversized stdout line.", failure: { reason: "protocol-overflow" } }
          : { error: "Claude Code process tree could not be confirmed stopped.", cleanupConfirmed: false }),
      });
      expect(terminateProcessTree).toHaveBeenCalledOnce();
    } finally {
      releaseCleanup();
      input.close();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      await removePortableFixture(root);
    }
  });
});
