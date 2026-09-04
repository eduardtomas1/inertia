// @inertia-test-suite portable
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
    expect(parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-terminal-first",
        status: "failed",
        summary: null,
        error: "Initial failure detail",
        _meta: { attempt: 1 },
      },
    }).update).toMatchObject({
      status: "failed",
      error: "Initial failure detail",
      _meta: { attempt: 1 },
    });
    expect(parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-terminal-first",
        status: "failed",
        summary: null,
        error: null,
        _meta: null,
      },
    }).update).toMatchObject({
      status: "failed",
      error: null,
      _meta: null,
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
    expect(() => parseAcpSessionNotification({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "compact-1",
        content: { type: "text", text: "Retained context" },
        _meta: [],
      },
    })).toThrow("malformed session update envelope");
  });

  it("keeps protocol identifiers bounded and control-free", () => {
    const accepted = "a".repeat(1_000);
    expect(parseAcpSessionNotification({
      sessionId: accepted,
      update: {
        sessionUpdate: "compaction_update",
        compactionId: accepted,
        status: "in_progress",
      },
    }).sessionId).toBe(accepted);

    for (const invalid of ["with\nnewline", "with\u007fdelete", "a".repeat(1_001)]) {
      expect(() => parseAcpSessionNotification({
        sessionId: invalid,
        update: {
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          status: "in_progress",
        },
      })).toThrow("malformed session update envelope");
      expect(() => parseAcpSessionNotification({
        sessionId: "session-1",
        update: {
          sessionUpdate: "compaction_update",
          compactionId: invalid,
          status: "in_progress",
        },
      })).toThrow("malformed session update envelope");
    }
  });
});
