import { afterEach, describe, expect, it, vi } from "vitest";

import { WATCHER_READ_ONLY_UNAVAILABLE_REFUSAL } from "../../src/server/persistence/watcher-link-repository";
import {
  cleanupWatcherFixtures,
  createWatcherFixture,
  watcherTestSelection,
} from "../support/watcher-runtime-fixture";

vi.mock("../../src/shared/watcher", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/watcher")>();
  return {
    ...original,
    watcherReadOnlyEnforcement: (harnessId: string) =>
      harnessId === "kimi-acp" ? null : original.watcherReadOnlyEnforcement(harnessId),
  };
});

afterEach(cleanupWatcherFixtures);

describe("read-only watchers on a harness without a read-only tier", () => {
  it("refuses a read-only attach but accepts the same agent with chat access", async () => {
    const f = await createWatcherFixture();
    try {
      await expect(f.attach({ modelSelection: watcherTestSelection("kimi") })).rejects.toThrow(WATCHER_READ_ONLY_UNAVAILABLE_REFUSAL);
      expect(f.store.watcherLinks.active()).toEqual([]);
      const link = await f.attach({ modelSelection: watcherTestSelection("kimi"), readOnly: false, interactionMode: "plan", accessMode: "supervised" });
      expect(link.readOnly).toBe(false);
      expect(() => f.store.watcherLinks.assertRunConfigurationAllowed(link.watcherConversationId, {
        interactionMode: "plan", accessMode: "supervised", harnessId: "kimi-acp",
      })).not.toThrow();
    } finally {
      await f.close();
    }
  });

  it("refuses to run an existing read-only link on that harness", async () => {
    const f = await createWatcherFixture();
    try {
      const link = await f.attach({ modelSelection: watcherTestSelection("codex") });
      expect(() => f.store.watcherLinks.assertRunConfigurationAllowed(link.watcherConversationId, {
        interactionMode: "plan", accessMode: "supervised", harnessId: "kimi-acp",
      })).toThrow(WATCHER_READ_ONLY_UNAVAILABLE_REFUSAL);
    } finally {
      await f.close();
    }
  });
});
