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
