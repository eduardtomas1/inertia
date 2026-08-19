import { describe, expect, it } from "vitest";

import {
  normalizedProviderRunFailure,
  providerPromiseFailure,
} from "../../src/server/runtime/turns/turn-controller-support";
import type { ActiveTurn } from "../../src/server/runtime/turns/turn-controller-types";

function activeTurn(): ActiveTurn {
  return {
    turn: { status: "running" },
    providerInput: {
      cwd: "/home/alice/project",
      harnessId: "codex-app-server",
    },
    providerActivitiesById: new Map([["command-42", {}]]),
  } as unknown as ActiveTurn;
}

describe("turn failure diagnostics", () => {
  it("captures a scrubbed stack for an in-process provider rejection", () => {
    const rejection = new Error("socket closed token=super-secret-value");
    rejection.stack = [
      "Error: socket closed token=super-secret-value",
      "    at connect (/home/alice/project/src/provider.ts:10:4)",
      "    at bearer (authorization=Bearer another-secret-value)",
    ].join("\n");

    const failure = providerPromiseFailure(activeTurn(), rejection);

    expect(failure.technicalDetail).toContain("Stack:");
    expect(failure.technicalDetail).toContain("<workspace>/src/provider.ts");
    expect(failure.technicalDetail).toContain("token=[redacted]");
    expect(failure.technicalDetail).not.toContain("super-secret-value");
    expect(failure.technicalDetail).not.toContain("another-secret-value");
    expect(failure.technicalDetail).not.toContain("/home/alice/project");
  });

  it("preserves a scrubbed provider error as summary and technical cause", () => {
    const failure = normalizedProviderRunFailure(activeTurn(), {
      providerId: "codex",
      conversationId: "conversation-1",
      status: "failed",
      text: "",
      textTruncated: false,
      exitCode: 23,
      signal: null,
      cleanupConfirmed: false,
      error: "prompt=private-request api_key=super-secret-value at /home/alice/project/file.ts\nSDK stack line",
    });

    expect(failure.message).toBe("prompt=[redacted] [redacted] at <workspace>/file.ts");
    expect(failure.technicalDetail).toContain("Reason: process-exit");
    expect(failure.technicalDetail).toContain("Exit code: 23");
    expect(failure.technicalDetail).toContain("Cleanup: unconfirmed");
    expect(failure.technicalDetail).toContain("Cause: prompt=[redacted]");
    expect(failure.technicalDetail).toContain("SDK stack line");
    expect(failure.technicalDetail).not.toContain("private-request");
    expect(failure.technicalDetail).not.toContain("super-secret-value");
    expect(failure.technicalDetail).not.toContain("/home/alice/project");
  });
});
