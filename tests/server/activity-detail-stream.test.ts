import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { AgentActivity } from "../../src/shared/contracts";
import { applyActivityDetailPatch } from "../../src/shared/activity-detail";
import {
  ACTIVITY_DETAIL_PREVIEW_CHARS,
  activityDetailPreview,
  activityPreviewFromProjectedRow,
  buildActivityPreviewQuery,
  type ProjectedActivityRow,
} from "../../src/server/persistence/activity-detail-preview";
import { activityDetailPatch } from "../../src/server/runtime/turns/activity-detail-patch";
import { materializeActivityEvent, withFullActivityDetail } from "../../src/renderer/src/utils/activityDetailStream";

function activity(detail: string | null, extra: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "activity", conversationId: "conversation", runId: "run", turnId: "turn",
    kind: "command", title: "npm test", detail, status: "running", createdAt: "2030-01-01T00:00:00.000Z", ...extra,
  };
}

describe("activity detail patches", () => {
  it("describes an append or a short tail rewrite and refuses anything else", () => {
    expect(activityDetailPatch("Output:\na", "Output:\nab", 1_024)).toEqual({ base: 9, offset: 9 });
    expect(activityDetailPatch("Output:\nabc", "Output:\nabX", 1_024)).toEqual({ base: 11, offset: 10 });
    expect(activityDetailPatch(undefined, "Output:\na", 1_024)).toBeNull();
    expect(activityDetailPatch("Output:\na", "Output:\na", 1_024)).toBeNull();
    expect(activityDetailPatch("abc", "xyz", 1_024)).toBeNull();
    expect(activityDetailPatch(`${"a".repeat(3_000)}tail`, `${"a".repeat(10)}\n… [9 or more characters omitted] …\n`, 1_024)).toBeNull();
    expect(activityDetailPatch("a😀", "a😁", 1_024)).toEqual({ base: 3, offset: 1 });
  });

  it("applies only on the exact base it was cut from", () => {
    expect(applyActivityDetailPatch("Output:\na", { base: 9, offset: 9 }, "b")).toBe("Output:\nab");
    expect(applyActivityDetailPatch("Output:\nabc", { base: 11, offset: 10 }, "X")).toBe("Output:\nabX");
    expect(applyActivityDetailPatch("Output:\n", { base: 9, offset: 9 }, "b")).toBeNull();
    expect(applyActivityDetailPatch(null, { base: 0, offset: 0 }, "b")).toBeNull();
    expect(applyActivityDetailPatch(undefined, { base: 1, offset: 1 }, "b")).toBeNull();
  });
});

describe("history previews", () => {
  it("keeps short and failure details whole and bounds long tool output with its error section", () => {
    expect(activityDetailPreview(activity("short"))).toEqual({ detail: "short" });
    expect(activityDetailPreview(activity(null))).toEqual({ detail: null });
    const failure = `Error: ${"x".repeat(9_000)}`;
    expect(activityDetailPreview(activity(failure, { kind: "error" }))).toEqual({ detail: failure });
    const long = `Output:\n${"o".repeat(10_000)}\nError:\nwarning: partial`;
    const preview = activityDetailPreview(activity(long));
    expect(preview.detailTruncated).toBe(true);
    expect(preview.detailBytes).toBe(new TextEncoder().encode(long).byteLength);
    expect(preview.detail!.startsWith(long.slice(0, ACTIVITY_DETAIL_PREVIEW_CHARS))).toBe(true);
    expect(preview.detail!.endsWith("\nError:\nwarning: partial")).toBe(true);
    expect(preview.detail).toMatch(/… \[\d+ or more characters omitted\] …/u);
    const status = activityDetailPreview(activity(`${"s".repeat(5_000)}\nError:\nlate`, { kind: "status" }));
    expect(status.detail).toBe("s".repeat(ACTIVITY_DETAIL_PREVIEW_CHARS));
  });

  it("matches JavaScript activityDetailPreview identically via SQLite preview projection", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE activities (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          turn_id TEXT,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          detail TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      const cases: Array<{ id: string; kind: AgentActivity["kind"]; detail: string | null }> = [
        { id: "null", kind: "command", detail: null },
        { id: "short", kind: "command", detail: "short output" },
        { id: "exact-boundary", kind: "command", detail: "a".repeat(ACTIVITY_DETAIL_PREVIEW_CHARS) },
        { id: "plain-long", kind: "command", detail: "x".repeat(12_000) },
        { id: "leading-error-short", kind: "command", detail: `Error:\n${"e".repeat(2_500)}` },
        { id: "leading-error-long", kind: "command", detail: `Error:\n${"e".repeat(10_000)}` },
        { id: "early-error", kind: "tool", detail: `${"a".repeat(500)}\nError:\n${"b".repeat(8_000)}` },
        { id: "boundary-error", kind: "file", detail: `${"a".repeat(2_048)}\nError:\n${"c".repeat(6_000)}` },
        { id: "late-error", kind: "command", detail: `${"a".repeat(9_000)}\nError:\nboom\n${"d".repeat(6_000)}` },
        { id: "status-long", kind: "status", detail: `${"s".repeat(5_000)}\nError:\nignored` },
        { id: "error-kind", kind: "error", detail: "e".repeat(9_000) },
        { id: "non-ascii", kind: "command", detail: `${"é".repeat(1_500)}😀${"z".repeat(4_000)}\nError:\nutf8` },
        { id: "surrogate-cut", kind: "command", detail: `${"a".repeat(ACTIVITY_DETAIL_PREVIEW_CHARS - 1)}😀${"b".repeat(3_000)}` },
        { id: "nul-before-error", kind: "command", detail: `${"a".repeat(3_000)}\0\nError:\nkept after nul` },
        { id: "short-multibyte-at-byte-boundary", kind: "status", detail: `${"s".repeat(ACTIVITY_DETAIL_PREVIEW_CHARS - 2)}€` },
        { id: "nul-after-multibyte-prefix", kind: "status", detail: `${"€".repeat(683)}\0kept after nul` },
        { id: "nul-after-multibyte-prefix-long", kind: "status", detail: `${"€".repeat(683)}\0${"t".repeat(3_000)}` },
      ];
      const insert = db.prepare(`
        INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
        VALUES (?, 'conv', 'run', 'turn', ?, 'cmd', ?, 'completed', '2030-01-01T00:00:00.000Z')
      `);
      for (const c of cases) insert.run(c.id, c.kind, c.detail);

      const rows = db.prepare(
        buildActivityPreviewQuery("1 = 1", "created_at ASC, id ASC"),
      ).all() as ProjectedActivityRow[];
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const c of cases) {
        const projected = byId.get(c.id)!;
        expect(activityPreviewFromProjectedRow(projected)).toEqual(
          activityDetailPreview({ kind: c.kind, detail: c.detail }),
        );
      }
      // Verify long non-error-excerpt rows are projected inside SQLite while command/non-ASCII rows stay exact.
      expect(byId.get("status-long")!.detail_projected).toBe(1);
      expect(byId.get("status-long")!.detail!.length).toBe(ACTIVITY_DETAIL_PREVIEW_CHARS);
      expect(byId.get("non-ascii")!.detail_projected).toBe(0);
      expect(activityPreviewFromProjectedRow(byId.get("nul-before-error")!).detail).toContain("kept after nul");
    } finally {
      db.close();
    }
  });
});

describe("renderer materialization of streamed activity", () => {
  it("applies patches in order onto the full detail it already has", () => {
    const first = materializeActivityEvent({ activity: activity("Output:\na") }, undefined);
    expect(first).toEqual({ activity: activity("Output:\na"), resync: false });
    const second = materializeActivityEvent({ activity: activity("b"), detailPatch: { base: 9, offset: 9 } }, first.activity);
    expect(second).toEqual({ activity: activity("Output:\nab"), resync: false });
  });

  it("asks for the full detail instead of corrupting text when a patch does not fit", () => {
    const gap = materializeActivityEvent({ activity: activity("c"), detailPatch: { base: 11, offset: 11 } }, activity("Output:\na"));
    expect(gap.resync).toBe(true);
    expect(gap.activity.detail).toBe("Output:\na");
    expect(gap.activity.detailTruncated).toBe(true);
    const preview = activity("Output:\nhead", { detailTruncated: true, detailBytes: 40_000 });
    const onPreview = materializeActivityEvent({ activity: activity("x"), detailPatch: { base: 12, offset: 12 } }, preview);
    expect(onPreview.resync).toBe(true);
    expect(onPreview.activity.detail).toBe("Output:\nhead");
    const unknown = materializeActivityEvent({ activity: activity("tail"), detailPatch: { base: 50, offset: 46 } }, undefined);
    expect(unknown).toMatchObject({ resync: true, activity: { detail: "tail", detailTruncated: true } });
  });

  it("takes a full replacement as is and drops preview markers once the full text arrives", () => {
    const replaced = materializeActivityEvent({ activity: activity("cut\n… [10 or more characters omitted] …\nend") }, activity("old"));
    expect(replaced).toEqual({ activity: activity("cut\n… [10 or more characters omitted] …\nend"), resync: false });
    expect(withFullActivityDetail(activity("head", { detailTruncated: true, detailBytes: 9 }), "head tail")).toEqual(activity("head tail"));
  });
});
