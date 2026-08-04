import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestStreamingTrace } from "../../src/server/runtime/test-streaming-trace";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-streaming-trace-"));
  directories.push(directory);
  return directory;
}

describe("test streaming trace", () => {
  it("remains disabled outside an explicit test runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INERTIA_STREAMING_TRACE", "1");
    const directory = temporaryDirectory();

    createTestStreamingTrace(directory).mark("provider-delta-received");

    expect(existsSync(join(directory, "streaming-trace.jsonl"))).toBe(false);
  });

  it("records bounded stage metadata when the benchmark opts in", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INERTIA_STREAMING_TRACE", "1");
    const directory = temporaryDirectory();

    createTestStreamingTrace(directory).mark("provider-delta-received");

    const tracePath = join(directory, "streaming-trace.jsonl");
    await vi.waitFor(() => {
      expect(readFileSync(tracePath, "utf8")).toContain("provider-delta-received");
    });
    const records = readFileSync(tracePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([{
      stage: "provider-delta-received",
      monotonicMs: expect.any(Number),
      wallTimeMs: expect.any(Number),
    }]);
  });
});
