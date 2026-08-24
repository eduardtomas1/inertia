import { describe, expect, it } from "vitest";

import { parseAcpSessionNotification } from "../../src/server/provider/acp-json-rpc";

describe("ACP session update validation", () => {
  it("accepts bounded compaction lifecycle and retained-summary frames", () => {
    expect(parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        summary: [{ type: "text", text: "Retained context" }],
        error: null,
      },
    }).update).toMatchObject({
      sessionUpdate: "compaction_update",
      compactionId: "compact-1",
      status: "completed",
    });
    expect(parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "compact-1",
        content: { type: "text", text: "Retained context" },
      },
    }).update).toMatchObject({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "compact-1",
    });
  });

  it("rejects malformed compaction payloads without widening the ACP boundary", () => {
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "",
        status: "completed",
      },
    })).toThrow("malformed session update envelope");
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "in_progress",
        summary: [{ type: "text", text: "Premature retained context" }],
      },
    })).toThrow("malformed session update envelope");
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        error: "Failure attached to a successful compaction",
      },
    })).toThrow("malformed session update envelope");
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "failed",
        _meta: [],
      },
    })).toThrow("malformed session update envelope");
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        summary: [{ type: "text" }],
      },
    })).toThrow("malformed session update envelope");
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "compact-1",
        content: { type: "future_content" },
      },
    })).toThrow("malformed session update envelope");
  });
});
