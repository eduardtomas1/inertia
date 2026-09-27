// @inertia-test-suite portable
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import { captured, fakeAppServer, processExists } from "../helpers/codex-app-server-fixture";
import { removePortableFixture, waitFor } from "../helpers/portable-provider-fixture";

describe("Codex follow-up acknowledgement ownership", () => {
  it.each([
    ["exact", true],
    ["missing", false],
    ["foreign", false],
    ["wrong-type", false],
    ["whitespace", false],
  ] as const)("accepts only an exact receipt: %s", async (scenario, accepted) => {
    const roots: string[] = [];
    const fake = fakeAppServer(roots);
    let running = false;
    const run = startCodexAppServerRun({
      executable: fake.command,
      cwd: fake.root,
      environment: {
        ...process.env,
        INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
        INERTIA_APP_SERVER_SCENARIO: `steer-receipt-${scenario}`,
      },
      prompt: "Wait for an exact follow-up.",
      access: "full",
      planMode: false,
      onStatus: (status) => { running = status === "running"; },
    });
    const imagePath = join(fake.root, "retained image.png");
    const input = { content: "Include this image.", imagePaths: [imagePath] };
    try {
      await waitFor("the exact Codex turn to start", () => running);
      // The fixture writes the receipt and terminal event in one stdout batch.
      // Completion must not erase a real receipt, or turn a foreign one into success.
      await expect(run.steer!(input)).resolves.toBe(accepted);
      await expect(run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
      expect(processExists(run.child.pid!)).toBe(false);
      const requests = captured(fake.capturePath).filter(({ method }) => method === "turn/steer");
      expect(requests).toEqual([expect.objectContaining({
        params: {
          threadId: "thread-new",
          expectedTurnId: "turn-1",
          input: [
            { type: "text", text: input.content, text_elements: [] },
            { type: "localImage", path: imagePath },
          ],
        },
      })]);
      await expect(run.steer!(input)).resolves.toBe(false);
      expect(captured(fake.capturePath).filter(({ method }) => method === "turn/steer")).toHaveLength(1);
    } finally {
      run.cancel(true);
      await run.result;
      await Promise.all(roots.map(removePortableFixture));
    }
  });
});

describe("Codex follow-up delivery uncertainty", () => {
  const input = { content: "Include the edge case.", imagePaths: [] };
  const unknownDelivery = { name: "ProviderSteerDeliveryUnknownError" };

  async function withSteerRun(
    scenario: string,
    rpcTimeoutMs: number | undefined,
    body: (run: ReturnType<typeof startCodexAppServerRun>, capturePath: string) => Promise<void>,
  ): Promise<void> {
    const roots: string[] = [];
    const fake = fakeAppServer(roots);
    let running = false;
    const run = startCodexAppServerRun({
      executable: fake.command,
      cwd: fake.root,
      environment: {
        ...process.env,
        INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
        INERTIA_APP_SERVER_SCENARIO: scenario,
      },
      prompt: "Wait for a follow-up.",
      access: "full",
      planMode: false,
      ...(rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs }),
      onStatus: (status) => { running = status === "running"; },
    });
    try {
      await waitFor("the Codex turn to start", () => running);
      await body(run, fake.capturePath);
    } finally {
      run.cancel(true);
      await run.result;
      await Promise.all(roots.map(removePortableFixture));
    }
  }

  const steerRequests = (capturePath: string) =>
    captured(capturePath).filter(({ method }) => method === "turn/steer");

  it("reports a lost steer acknowledgement as unknown delivery", async () => {
    await withSteerRun("steer-receipt-lost", 1_000, async (run, capturePath) => {
      await expect(run.steer!(input)).rejects.toMatchObject(unknownDelivery);
      expect(steerRequests(capturePath)).toHaveLength(1);
    });
  });

  it("keeps a late steer acknowledgement unknown without resending", async () => {
    await withSteerRun("steer-receipt-late", 1_000, async (run, capturePath) => {
      await expect(run.steer!(input)).rejects.toMatchObject(unknownDelivery);
      await expect(run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
      expect(steerRequests(capturePath)).toHaveLength(1);
    });
  });

  it("keeps an explicit native steer rejection rejected", async () => {
    await withSteerRun("steer-receipt-refused", undefined, async (run) => {
      await expect(run.steer!(input)).resolves.toBe(false);
    });
  });

  it("reports a steer pending during Stop as unknown delivery", async () => {
    await withSteerRun("steer-receipt-lost", undefined, async (run, capturePath) => {
      const steering = run.steer!(input);
      await waitFor("the steer request to reach Codex", () => steerRequests(capturePath).length === 1);
      run.cancel();
      await expect(steering).rejects.toMatchObject(unknownDelivery);
      await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
      expect(steerRequests(capturePath)).toHaveLength(1);
    });
  });
});
