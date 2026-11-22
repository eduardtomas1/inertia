// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { ProviderManager } from "../../src/server/providers";
import { MAX_PROVIDER_STOP_REASON_CHARS } from "../../src/shared/orchestration-v2";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { fakeAppServer as createFakeAppServer } from "../helpers/codex-app-server-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const STOP_REASON = "Stop hook (project): Tests are still failing.\nFix lint first.";
/** A launch credential (the key ends in TOKEN) the fixture echoes in hook stop text. */
const SECRET = "glpat-Q7xZ9mK2vR4tY8wP1nB6cD3fH5jL0sXa";

interface Activity { kind: string; phase: string; label: string; activityId?: string; detail?: string }

function secretFragments(value: string): string[] {
  // Any eight-character window of the credential's random part.
  const body = SECRET.slice("glpat-".length);
  return Array.from({ length: body.length - 7 }, (unused, index) => body.slice(index, index + 8))
    .filter((fragment) => value.includes(fragment));
}

describe("Codex hook stop reason (T3 c02b98bb3, c440fd19d)", { concurrent: false }, () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  async function run(scenario: string, onActivity?: (activity: Activity, manager: ProviderManager) => void) {
    const fake = createFakeAppServer(roots);
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = scenario;
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          INERTIA_APP_SERVER_CAPTURE: fake.capturePath,
          INERTIA_APP_SERVER_SCENARIO: scenario,
          GITLAB_TOKEN: SECRET,
        },
      }),
    });
    managers.push(manager);
    const activities: Activity[] = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `conversation-${scenario}`,
      cwd: fake.root,
      prompt: "Run the checks",
      interactionMode: "build",
      access: "full",
    }), { onActivity: (event) => {
      activities.push(event);
      onActivity?.(event, manager);
    } });
    return { result, activities };
  }

  it("records a hook stop on a completed turn", async () => {
    const { result, activities } = await run("hook-stop-completed");
    expect(result).toMatchObject({ status: "completed", text: "Partial report", providerStopReason: STOP_REASON });
    // The notice is added at settlement, once the run's outcome is known, never by the adapter.
    expect(activities.some(({ label }) => label === "Stopped by the provider")).toBe(false);
  });

  it("records a hook stop on a turn Codex ends interrupted", async () => {
    const { result, activities } = await run("hook-stop-interrupted");
    // Inertia settles a Codex interruption that nobody asked for and that carries no error as cancelled.
    expect(result).toMatchObject({ status: "cancelled", providerStopReason: STOP_REASON });
    expect(result).not.toHaveProperty("failure");
    expect(activities.find(({ label }) => label === "Turn interrupted")?.detail).toBeUndefined();
  });

  it("drops the hook stop when the user's Stop ends the turn", async () => {
    let cancelled = false;
    const { result } = await run("hook-stop-user-stop", (activity, manager) => {
      if (cancelled || activity.label !== "Hook · Stop") return;
      cancelled = manager.cancel("conversation-hook-stop-user-stop");
    });
    expect(cancelled).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result).not.toHaveProperty("providerStopReason");
  });

  it("gives no reason to a run whose later native turn fails", async () => {
    const { result, activities } = await run("hook-stop-goal-failed");
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("providerStopReason");
    expect(activities.some(({ label }) => label === "Stopped by the provider")).toBe(false);
  });

  it("lets a later native turn clear or replace the reason", async () => {
    const cleared = await run("hook-stop-goal-cleared");
    expect(cleared.result.status).toBe("completed");
    expect(cleared.result).not.toHaveProperty("providerStopReason");
    expect(cleared.activities.some(({ label }) => label === "Stopped by the provider")).toBe(false);
    const replaced = await run("hook-stop-goal-replaced");
    expect(replaced.result).toMatchObject({ status: "completed", providerStopReason: "PostToolUse hook: Second stop." });
  });

  it("rejects malformed hook stops whole, as T3's decoder does", async () => {
    const { result } = await run("hook-stop-malformed");
    // Each malformed stop follows the valid one and would replace it if it were accepted.
    expect(result).toMatchObject({ status: "completed", text: "Partial report", providerStopReason: STOP_REASON });
  });

  it("redacts a credential that straddles the cut and bounds a reason built from long entries", async () => {
    const { result } = await run("hook-stop-oversized");
    const reason = result.providerStopReason!;
    expect(reason.length).toBeLessThanOrEqual(MAX_PROVIDER_STOP_REASON_CHARS);
    expect(reason.startsWith(`${"E".repeat(120)} hook: ${"S".repeat(10)}`)).toBe(true);
    expect(reason).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
    expect(reason).toContain("[redacted]");
    expect(secretFragments(reason)).toEqual([]);
    expect(reason).not.toContain("T".repeat(64));
  });
});
