import { describe, expect, it } from "vitest";

import {
  DetachedRuntimeCapabilityRegistry,
} from "../../src/node/detached-runtime-capability";
import {
  detachedRuntimeConnection,
  runtimeConnection,
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
        invalidBackupsSkipped: 0,
        unsupportedBackupsSkipped: 0,
      },
      databaseRecoveryNoticePending: true,
      lastError: null,
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
});
