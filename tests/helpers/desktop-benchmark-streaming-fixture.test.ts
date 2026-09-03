import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  STREAMING_COMPLETION_GATE_TIMEOUT_MS,
  STREAMING_PROGRESSIVE_PAINT_COUNT,
  beginStreamingReaderActivity,
  beginStreamingReaderAwayActivity,
  releaseStreamingCadence,
  releaseStreamingCompletion,
  streamingReaderActivityMarker,
  streamingAppServer,
  waitForStreamingCompletionCleanup,
  waitForStreamingCompletionReady,
  waitForStreamingReaderActivity,
  waitForStreamingReaderAwayActivity,
} from "./desktop-benchmark-streaming-fixture";

interface FixtureRun {
  child: ChildProcessWithoutNullStreams;
  messages: Record<string, unknown>[];
  stderr: string[];
}

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    child.stdin.end();
    child.kill();
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

async function startFixture(
  environment: Record<string, string>,
): Promise<{ run: FixtureRun; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "inertia-streaming-fixture-"));
  roots.push(workspace);
  const script = join(workspace, "app-server.cjs");
  await writeFile(script, streamingAppServer, "utf8");
  const child = spawn(process.execPath, [script], {
    cwd: workspace,
    env: { ...process.env, ...environment },
    stdio: "pipe",
  });
  children.add(child);
  const run: FixtureRun = { child, messages: [], stderr: [] };
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (line) run.messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => run.stderr.push(chunk));
  return { run, workspace };
}

function beginSample(run: FixtureRun, sampleNumber: number): void {
  run.child.stdin.write(`${JSON.stringify({
    id: sampleNumber,
    method: "turn/start",
    params: {
      input: [{ type: "text", text: `Run sample ${sampleNumber}.` }],
    },
  })}\n`);
}

function isTerminalMessage(message: Record<string, unknown>): boolean {
  return message.method === "turn/completed";
}

function providerDeltaMessages(run: FixtureRun): Record<string, unknown>[] {
  return run.messages.filter((message) => (
    message.method === "item/agentMessage/delta"
  ));
}

function providerDeltaText(run: FixtureRun): string[] {
  return providerDeltaMessages(run).map((message) => {
    const params = message.params as { delta?: unknown } | undefined;
    return typeof params?.delta === "string" ? params.delta : "";
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = STREAMING_COMPLETION_GATE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture output.");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

async function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolveExit) => child.once("exit", resolveExit));
}

describe("desktop benchmark streaming completion gate", () => {
  it("owns exact, sample-scoped markers for both bounded reader pulses", () => {
    expect(streamingReaderActivityMarker(7, "BEFORE"))
      .toBe("STREAM_PROVIDER_READER_ACTIVITY_7_BEFORE");
    expect(streamingReaderActivityMarker(7, "AWAY"))
      .toBe("STREAM_PROVIDER_READER_ACTIVITY_7_AWAY");
    expect(() => streamingReaderActivityMarker(0, "AWAY"))
      .toThrow("Streaming sample numbers must be positive integers.");
  });

  it("holds completion through reader activity until release and cleans its gate files", async () => {
    const { run, workspace } = await startFixture({
      INERTIA_BENCHMARK_COMPLETION_GATE_TIMEOUT_MS: "2000",
      INERTIA_BENCHMARK_STREAM_INTERVAL_MS: "1",
    });
    beginSample(run, 7);

    for (
      let ordinal = 1;
      ordinal <= STREAMING_PROGRESSIVE_PAINT_COUNT;
      ordinal += 1
    ) {
      await waitFor(() => providerDeltaMessages(run).length >= ordinal);
      expect(providerDeltaMessages(run)).toHaveLength(ordinal);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      expect(providerDeltaMessages(run)).toHaveLength(ordinal);
      await releaseStreamingCadence(workspace, 7);
    }

    await waitForStreamingCompletionReady(workspace, 7);
    const streamedPayload = providerDeltaText(run);
    expect(streamedPayload).toHaveLength(128);
    expect(streamedPayload[0]).toMatch(/^STREAM_PROVIDER_DELTA_7_\d+ $/u);
    expect(streamedPayload.slice(1)).toEqual(Array.from(
      { length: 127 },
      (_, index) => `chunk-${index + 1}🙂 `,
    ));
    expect(run.messages.some(isTerminalMessage)).toBe(false);
    await beginStreamingReaderActivity(workspace, 7);
    await waitForStreamingReaderActivity(workspace, 7);
    await waitFor(() => run.messages.some((message) => JSON.stringify(message)
      .includes(streamingReaderActivityMarker(7, "BEFORE"))));
    expect(run.messages.some(isTerminalMessage)).toBe(false);
    await beginStreamingReaderAwayActivity(workspace, 7);
    await waitForStreamingReaderAwayActivity(workspace, 7);
    await waitFor(() => run.messages.some((message) => JSON.stringify(message)
      .includes(streamingReaderActivityMarker(7, "AWAY"))));
    expect(run.messages.some(isTerminalMessage)).toBe(false);

    await releaseStreamingCompletion(workspace, 7);
    await waitFor(() => run.messages.some(isTerminalMessage));
    await waitForStreamingCompletionCleanup(workspace, 7);

    const completionIndex = run.messages.findIndex(isTerminalMessage);
    const markerIndex = run.messages.findIndex((message) => JSON.stringify(message)
      .includes("STREAM_PROVIDER_COMPLETE_7_"));
    const activityMessages = run.messages.filter((message) => JSON.stringify(message)
      .includes("STREAM_PROVIDER_READER_ACTIVITY_7_"));
    expect(activityMessages).toHaveLength(2);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(completionIndex).toBeGreaterThan(markerIndex);
  });

  it("fails closed on a bounded unreleased gate and removes its files", async () => {
    const { run, workspace } = await startFixture({
      INERTIA_BENCHMARK_COMPLETION_GATE_TIMEOUT_MS: "200",
      INERTIA_BENCHMARK_STREAM_INTERVAL_MS: "1",
    });
    beginSample(run, 9);

    await waitFor(() => providerDeltaMessages(run).length >= 1);
    for (
      let ordinal = 1;
      ordinal <= STREAMING_PROGRESSIVE_PAINT_COUNT;
      ordinal += 1
    ) {
      if (ordinal > 1) {
        await waitFor(() => providerDeltaMessages(run).length >= ordinal);
      }
      await releaseStreamingCadence(workspace, 9);
    }

    await waitForStreamingCompletionReady(workspace, 9);
    expect(await exitCode(run.child)).toBe(2);
    children.delete(run.child);
    await waitForStreamingCompletionCleanup(workspace, 9);
    expect(run.messages.some(isTerminalMessage)).toBe(false);
    expect(run.stderr.join("")).toContain("Benchmark completion gate timed out.");
  });

  it("fails closed when a progressive cadence acknowledgement is withheld", async () => {
    const { run, workspace } = await startFixture({
      INERTIA_BENCHMARK_COMPLETION_GATE_TIMEOUT_MS: "200",
      INERTIA_BENCHMARK_STREAM_INTERVAL_MS: "1",
    });
    beginSample(run, 11);

    await waitFor(() => providerDeltaMessages(run).length >= 1);
    expect(await exitCode(run.child)).toBe(2);
    children.delete(run.child);
    await waitForStreamingCompletionCleanup(workspace, 11);
    expect(providerDeltaMessages(run)).toHaveLength(1);
    expect(run.messages.some(isTerminalMessage)).toBe(false);
    expect(run.stderr.join(""))
      .toContain("Benchmark cadence gate timed out at ordinal 1.");
  });
});
