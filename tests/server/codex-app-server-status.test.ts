import { describe, expect, it } from "vitest";

import {
  codexHookActivityPhase,
  codexItemActivityPhase,
  type CodexCommandOrPatchStatus,
  type CodexHookStatus,
} from "../../src/server/codex/app-server-status";
import { CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS } from "../../src/server/codex/app-server-notifications";
import { CODEX_APP_SERVER_REQUEST_DISPOSITIONS } from "../../src/server/codex/app-server-requests";

describe("Codex App Server generated lifecycle surfaces", () => {
  it.each([
    ["inProgress", "started"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["declined", "failed"],
  ] satisfies Array<[CodexCommandOrPatchStatus, string]>) (
    "maps command/file status %s without projecting refusal as completion",
    (status, expected) => {
      expect(codexItemActivityPhase("item/completed", status)).toBe(expected);
    },
  );

  it.each([
    ["running", "started"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["blocked", "failed"],
    ["stopped", "failed"],
  ] satisfies Array<[CodexHookStatus, string]>) (
    "maps hook status %s exhaustively",
    (status, expected) => {
      expect(codexHookActivityPhase("hook/completed", status)).toBe(expected);
    },
  );

  it("preserves legacy missing-status notifications and fails unknown statuses closed", () => {
    expect(codexItemActivityPhase("item/started", undefined)).toBe("started");
    expect(codexItemActivityPhase("item/completed", undefined)).toBe("completed");
    expect(codexHookActivityPhase("hook/started", undefined)).toBe("started");
    expect(codexHookActivityPhase("hook/completed", undefined)).toBe("completed");
    expect(codexItemActivityPhase("item/completed", "future-status")).toBe("failed");
    expect(codexHookActivityPhase("hook/completed", "future-status")).toBe("failed");
  });

  it("keeps an explicit disposition for every reviewed 0.149 notification", () => {
    expect(Object.keys(CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS)).toHaveLength(77);
    expect(CODEX_APP_SERVER_NOTIFICATION_DISPOSITIONS).toMatchObject({
      "autoApprovalReview/strictReviewRequired": "projected",
      "hook/completed": "projected",
      "item/autoApprovalReview/completed": "projected",
      "item/plan/delta": "projected",
      "mcpServer/startupStatus/updated": "projected",
      "model/safetyBuffering/updated": "projected",
      "model/verification": "projected",
      "process/outputDelta": "ignored",
      "project/changed": "ignored",
      "rawResponse/completed": "ignored",
      "thread/environment/connected": "projected",
      "thread/project/updated": "ignored",
      "thread/realtime/transcript/delta": "ignored",
      "thread/settings/updated": "projected",
      "turn/diff/updated": "projected",
      "windows/worldWritableWarning": "projected",
      guardianWarning: "projected",
    });
  });

  it("keeps an explicit disposition for every reviewed 0.149 server request", () => {
    expect(Object.keys(CODEX_APP_SERVER_REQUEST_DISPOSITIONS)).toHaveLength(11);
    expect(CODEX_APP_SERVER_REQUEST_DISPOSITIONS).toMatchObject({
      "item/commandExecution/requestApproval": "handled",
      "item/fileChange/requestApproval": "handled",
      "item/tool/requestUserInput": "handled",
      "mcpServer/elicitation/request": "declined",
      "item/permissions/requestApproval": "handled",
      "item/tool/call": "handled",
      "account/chatgptAuthTokens/refresh": "unsupported",
      "attestation/generate": "disabled",
      "currentTime/read": "handled",
      applyPatchApproval: "handled",
      execCommandApproval: "handled",
    });
  });
});
