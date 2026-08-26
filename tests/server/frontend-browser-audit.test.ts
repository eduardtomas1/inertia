import { describe, expect, it } from "vitest";

import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";
import { withFrontendBrowserAudit } from "../../src/server/runtime/frontend-browser-audit";

function element(
  ref: string,
  input: Partial<{
    role: string;
    name: string;
    nameSource: string;
    actionable: boolean;
    editable: boolean;
    disabled: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = {},
) {
  return {
    ref,
    role: input.role ?? "button",
    name: input.name ?? "Action",
    nameSource: input.nameSource ?? "content",
    actionable: input.actionable ?? false,
    editable: input.editable ?? false,
    disabled: input.disabled ?? false,
    rect: {
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width ?? 100,
      height: input.height ?? 32,
    },
  };
}

describe("frontend Browser audit", () => {
  it("adds stable semantic issue codes without inventing pixel evidence", () => {
    const audited = JSON.parse(withFrontendBrowserAudit(JSON.stringify({
      title: "Local app",
      viewport: { width: 320, height: 200, scrollX: 0, scrollY: 0 },
      text: "Dashboard",
      elements: [
        element("unnamed", { name: "", nameSource: "none", width: 20, height: 20 }),
        element("overlap", { x: 0, y: 0, width: 20, height: 20 }),
        element("clipped", { x: 310, width: 40 }),
        element("weak-checkbox", {
          role: "checkbox", name: "on", nameSource: "value",
        }),
        element("unlabelled-editor", {
          role: "textbox", name: "draft text", nameSource: "value",
        }),
        element("region-editor", {
          role: "region", name: "draft region", nameSource: "value", editable: true,
        }),
        element("titled-editor", {
          role: "textbox", name: "Editor", nameSource: "title", editable: true,
        }),
        element("disabled", { name: "", disabled: true, width: 10, height: 10 }),
      ],
      truncated: false,
    }))) as {
      inertiaAudit: {
        scope: string;
        errors: number;
        warnings: number;
        issues: Array<{ code: string; count: number; refs: string[] }>;
        limitations: string[];
      };
    };

    expect(audited.inertiaAudit).toMatchObject({
      scope: "current-semantic-viewport",
      errors: 4,
    });
    expect(audited.inertiaAudit.issues.map(({ code }) => code)).toEqual([
      "missing-stable-name",
      "clipped-control",
      "overlapping-controls",
      "small-target",
    ]);
    expect(audited.inertiaAudit.issues.find(({ code }) =>
      code === "missing-stable-name")?.refs).toEqual([
        "unnamed",
        "weak-checkbox",
        "unlabelled-editor",
        "region-editor",
      ]);
    expect(audited.inertiaAudit.limitations.join(" ")).toContain("pixel-level");
    expect(JSON.stringify(audited)).not.toContain("WCAG");
  });

  it("keeps augmented snapshots valid and inside the provider byte limit", () => {
    const result = withFrontendBrowserAudit(JSON.stringify({
      title: "Dense page",
      viewport: { width: 1_200, height: 800, scrollX: 0, scrollY: 0 },
      text: "界".repeat(12_000),
      elements: Array.from({ length: 200 }, (_, index) => element(
        `e${index}`,
        { name: "界".repeat(300), x: index * 2 },
      )),
      truncated: false,
    }));

    expect(Buffer.byteLength(result, "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    const parsed = JSON.parse(result) as {
      truncated: boolean;
      elements: unknown[];
      inertiaAudit: { version: number };
    };
    expect(parsed).toMatchObject({
      truncated: true,
      inertiaAudit: { version: 1 },
    });
    expect(parsed.elements.length).toBeLessThan(200);
  });

  it("uses fractional CSS geometry at exact target and viewport thresholds", () => {
    const audited = JSON.parse(withFrontendBrowserAudit(JSON.stringify({
      viewport: { width: 320, height: 200 },
      elements: [
        element("small", { width: 23.6, height: 24 }),
        element("left-clipped", { x: -0.4, width: 24, height: 24 }),
        element("right-clipped", { x: 0.4, width: 319.7, height: 24 }),
        element("exact-edge", { x: 296, width: 24, height: 24 }),
      ],
    }))) as {
      inertiaAudit: { issues: Array<{ code: string; refs: string[] }> };
    };
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "small-target")?.refs)
      .toEqual(["small"]);
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "clipped-control")?.refs)
      .toEqual(["left-clipped", "right-clipped"]);
  });

  it("measures overlap relative to subpixel targets and rejects empty rectangles", () => {
    const audited = JSON.parse(withFrontendBrowserAudit(JSON.stringify({
      viewport: { width: 320, height: 200 },
      elements: [
        element("tiny-a", { width: 0.5, height: 0.5 }),
        element("tiny-b", { width: 0.5, height: 0.5 }),
        element("empty", { width: 0 }),
        element("collapsed", { x: Number.MAX_VALUE, width: 1 }),
      ],
    }))) as {
      inertiaAudit: {
        checkedElements: number;
        issues: Array<{ code: string; refs: string[] }>;
      };
    };
    expect(audited.inertiaAudit.checkedElements).toBe(2);
    expect(audited.inertiaAudit.issues.find(({ code }) => code === "overlapping-controls")?.refs)
      .toEqual(["tiny-a", "tiny-b"]);
  });

  it("passes malformed provider-visible text through unchanged", () => {
    expect(withFrontendBrowserAudit("not-json")).toBe("not-json");
    expect(withFrontendBrowserAudit(JSON.stringify({ elements: "invalid" })))
      .toBe(JSON.stringify({ elements: "invalid" }));
  });
});
