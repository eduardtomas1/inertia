import { describe, expect, it } from "vitest";

import type { AgentActivity } from "../../src/shared/contracts";
import { applyActivityDetailPatch } from "../../src/shared/activity-detail";
import { ACTIVITY_DETAIL_PREVIEW_CHARS, activityDetailPreview } from "../../src/server/persistence/activity-detail-preview";
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
