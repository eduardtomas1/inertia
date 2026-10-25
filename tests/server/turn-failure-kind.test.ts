import { afterEach, describe, expect, it } from "vitest";

import { codexFailureKind } from "../../src/server/codex/app-server-status";
import { turnFailureKind } from "../../src/server/runtime/turns/turn-failure-kind";
import { TURN_FAILURE_KINDS } from "../../src/shared/turn-lifecycle";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("turn failure kinds", () => {
  it("lists the stable kinds the renderer can explain", () => {
    expect(TURN_FAILURE_KINDS).toEqual(["billing", "authentication", "rate-limited", "model-not-found"]);
  });

  it.each([
    [{ reason: "provider-error", message: "x", failureKind: "billing" }, "billing"],
    [{ reason: "codex-error", message: "x", usageLimited: true }, "rate-limited"],
    [{ reason: "provider-error", message: "x", phase: "auth" }, "authentication"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/billing_error" }, "billing"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/authentication_failed" }, "authentication"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/oauth_org_not_allowed" }, "authentication"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/rate_limit" }, "rate-limited"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/model_not_found" }, "model-not-found"],
    [{ reason: "provider-error", message: "x", terminalEvent: "assistant/server_error" }, undefined],
    [{ reason: "process-exit", message: "x" }, undefined],
  ] as const)("derives %o as %s", (failure, expected) => {
    expect(turnFailureKind(failure as Parameters<typeof turnFailureKind>[0])).toBe(expected);
  });

  it.each([
    ["unauthorized", "authentication"],
    ["usageLimitExceeded", "rate-limited"],
    ["rateLimitExceeded", "rate-limited"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 401 } }, undefined],
    ["badRequest", undefined],
    [null, undefined],
  ] as const)("maps the Codex error info %o to %s", (errorInfo, expected) => {
    expect(codexFailureKind(errorInfo)).toBe(expected);
  });

  it.each([
    [{ reason: "provider-error", message: "Claude could not continue because of an account billing issue.", terminalEvent: "assistant/billing_error" }, "billing"],
    [{ reason: "codex-error", message: "Usage limit reached", usageLimited: true }, "rate-limited"],
    [{ reason: "provider-error", message: "Something else went wrong." }, undefined],
  ] as const)("records the failure kind with the failed turn: %o", async (failure, expected) => {
    const runtime = await createTurnControllerTestRuntime();
    try {
      const turn = runtime.controller.queue({ conversationId: runtime.conversationId, content: "First task" });
      runtime.controller.start(turn.turn.id);
      await flushTurnControllerTestPromises();
      runtime.provider.resolve({ status: "failed", text: failure.message, failure });
      await flushTurnControllerTestPromises();
      await runtime.controller.waitForProviderCleanup([runtime.conversationId]);

      const shell = runtime.store.shellSnapshot().conversations
        .find(({ id }) => id === runtime.conversationId);
      expect(shell?.latestTurn?.status).toBe("failed");
      expect(shell?.latestTurn?.failureKind).toBe(expected);
    } finally {
      await runtime.controller.dispose();
      runtime.store.close();
    }
  });
});

describe("PersistTurnFailureKinds migration", () => {
  it("adds a constrained side table that follows its turn", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { migrateRuntimeDatabase } = await import("../../src/server/persistence/migrations/runtime-catalog");
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 102);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'turn_failure_kinds'").get()).toBeUndefined();
      migrateRuntimeDatabase(database, 103);
      const columns = database.prepare("PRAGMA table_info(turn_failure_kinds)").all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual(["turn_id", "failure_kind"]);
      expect(database.prepare("PRAGMA foreign_key_list(turn_failure_kinds)").all())
        .toEqual([expect.objectContaining({ table: "agent_turns", from: "turn_id", on_delete: "CASCADE" })]);
    } finally {
      database.close();
    }
  });
});
