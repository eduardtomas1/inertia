import { describe, expect, it } from "vitest";

import { isSafeApprovalDisplayText } from "../../src/server/provider/approval-display";

describe("provider approval display safety", () => {
  it("accepts ordinary single-line and explicitly allowed multiline copy", () => {
    expect(isSafeApprovalDisplayText("Run npm test -- --runInBand")).toBe(true);
    expect(isSafeApprovalDisplayText("src/app.ts\npackage.json", true)).toBe(true);
  });

  it.each([
    "Run safe\u202Etxt.exe",
    "Run\u2066 npm test",
    "Run\u0000npm test",
    "Run\u0085npm test",
    "Run\u2028npm test",
  ])("rejects invisible or direction-changing approval copy", (value) => {
    expect(isSafeApprovalDisplayText(value, true)).toBe(false);
  });

  it("allows line breaks only for fields rendered as multiline detail", () => {
    expect(isSafeApprovalDisplayText("first\nsecond")).toBe(false);
    expect(isSafeApprovalDisplayText("first\nsecond", true)).toBe(true);
  });
});
