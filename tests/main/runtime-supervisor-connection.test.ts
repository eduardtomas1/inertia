import { describe, expect, it } from "vitest";

import {
  DetachedRuntimeCapabilityRegistry,
} from "../../src/node/detached-runtime-capability";
import {
  detachedRuntimeConnection,
  runtimeConnection,
  RuntimeConnectionUnavailableError,
  unavailableRuntimeConnection,
} from "../../src/main/runtime-supervisor-connection";

const websocketUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const conversationId = "22222222-2222-4222-8222-222222222222";

describe("runtime supervisor connection", () => {
  it("mints a scoped detached URL without carrying the main recovery notice", () => {
    const mainConnection = runtimeConnection({
      phase: "ready",
      generation: 1,
      websocketUrl,
      databaseRecoveryReport: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        outcome: "restored",
        trigger: "primary-corrupt",
        restoredBackup: "backup.sqlite",
        preservedCorruptPrimary: true,
        preservedDatabaseFamilyMembers: 1,
        invalidBackupsSkipped: 0,
        unsupportedBackupsSkipped: 0,
      },
      databaseRecoveryNoticePending: true,
      startupBlockerCode: null,
    }).connection;
    const detached = detachedRuntimeConnection(
      mainConnection,
      conversationId,
      "web-contents:7",
    );

    const detachedUrl = new URL(detached.websocketUrl);
    expect(detached).not.toHaveProperty("databaseRecoveryNotice");
    expect(detachedUrl.pathname).toBe("/runtime-detached");
    expect(detached.websocketUrl).not.toContain(new URL(websocketUrl).pathname);
    const verification = new DetachedRuntimeCapabilityRegistry({
      websocketPath: new URL(websocketUrl).pathname,
      secret: websocketUrl,
    }).verifyAndConsume(`${detachedUrl.pathname}${detachedUrl.search}`);
    expect(verification).toMatchObject({
      kind: "accepted",
      authority: { conversationId, clientId: "web-contents:7" },
    });
  });

  it("never projects arbitrary child errors or locations", () => {
    const privateDetail =
      "spawn failed at /mnt/customer/roadmap.txt prompt=TOP_SECRET";
    let caught: unknown;
    try {
      runtimeConnection({
        phase: "restarting",
        generation: 2,
        websocketUrl: null,
        databaseRecoveryReport: null,
        databaseRecoveryNoticePending: false,
        startupBlockerCode: null,
        // Model the supervisor's private lastError without adding it back to
        // the renderer-facing connection contract.
        lastError: privateDetail,
      } as Parameters<typeof runtimeConnection>[0] & { lastError: string });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuntimeConnectionUnavailableError);
    const connection = (caught as RuntimeConnectionUnavailableError)
      .connection;
    expect(connection).toEqual({
      unavailable: true,
      code: "runtime-restarting",
      retryable: true,
      message: "The local service is restarting. Try again in a moment.",
    });
    expect(JSON.stringify(connection)).not.toContain(privateDetail);
    expect(JSON.stringify(connection)).not.toContain("roadmap.txt");
    expect(JSON.stringify(connection)).not.toContain("TOP_SECRET");
  });

  it.each([
    [
      "prior-runtime-cleanup-unconfirmed",
      "Runtime startup is blocked because prior process cleanup remains unconfirmed. Review Lifecycle Integrity in Settings.",
    ],
    [
      "provider-installation-quarantined",
      "Runtime startup is blocked because provider installation recovery requires manual attention. Review Lifecycle Integrity in Settings.",
    ],
  ] as const)(
    "classifies %s as a finite non-retryable blocker",
    (startupBlockerCode, message) => {
      expect(unavailableRuntimeConnection({
        phase: "stopped",
        startupBlockerCode,
      })).toEqual({
        unavailable: true,
        code: startupBlockerCode,
        retryable: false,
        message,
      });
    },
  );
});
