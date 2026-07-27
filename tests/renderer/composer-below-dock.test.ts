import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { usageDisplayBehavior } from "../../src/renderer/src/utils/usageDisplay";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");
const chatWorkspaceSource = readFileSync(
  new URL("../../src/renderer/src/components/ChatWorkspace.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");

describe("composer below-dock cleanup", () => {
  it("ends the Composer and workspace topology at the dock", () => {
    expect(composerSource).toMatch(
      /<div className="composer-shell">\s*<section[\s\S]*?<\/section>\s*<\/div>\s*\);/u,
    );
    expect(chatWorkspaceSource).toMatch(
      /<div ref=\{composerRegionRef\} className="composer-region">\s*<Composer[\s\S]*?\/>\s*<\/div>\s*<\/main>/u,
    );
    expect(composerSource).not.toMatch(
      /composer-(?:footer|note|helper|usage-strip|spacer)/u,
    );
  });

  it("keeps contextual content inside the dock instead of reserving a lower row", () => {
    const dockStart = composerSource.indexOf("<section");
    const dockEnd = composerSource.indexOf("</section>", dockStart);
    const dock = composerSource.slice(dockStart, dockEnd);

    for (const marker of [
      'className="provider-readiness"',
      "<ComposerAttachmentList",
      'className="composer-attachment-boundary"',
      'className="composer-route-confirmation"',
      'className="composer-toolbar"',
      "<UsageIndicator",
    ]) {
      expect(dock, marker).toContain(marker);
    }
    expect(dock).toContain('running\n                ? "Add a follow-up while the agent works…"');
    expect(dock).toContain('className="secondary-button composer-follow-up-button"');
    expect(dock).toContain('className="composer-follow-up-unavailable"');
  });

  it("uses anchored or hidden usage modes without a permanent detail strip", () => {
    for (const mode of ["hidden", "compact", "expanded"] as const) {
      expect(usageDisplayBehavior(mode).showPermanentStrip).toBe(false);
    }
    expect(usageDisplayBehavior("hidden").surface).toBe("hidden");
    expect(usageDisplayBehavior("compact").surface).toBe("circle");
    expect(usageDisplayBehavior("expanded").surface).toBe("circle-with-value");
  });

  it("removes the obsolete lower padding at every composer-shell breakpoint", () => {
    const shellRules = [...css.matchAll(
      /\.composer-shell\s*\{(?<body>[^}]*)\}/gu,
    )].map((match) => match.groups?.body ?? "");

    expect(shellRules).toHaveLength(2);
    expect(shellRules).toEqual(expect.arrayContaining([
      expect.stringContaining("padding: 7px clamp(18px, 4vw, 54px) 0"),
      expect.stringContaining("padding: 7px 9px 0"),
    ]));
    for (const rule of shellRules) {
      expect(rule).not.toMatch(/padding-bottom:\s*[1-9]/u);
    }
  });
});
