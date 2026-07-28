import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { usageDisplayBehavior } from "../../src/renderer/src/utils/usageDisplay";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/Composer.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");
const inputSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerInputZone.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/gu, "\n");
const toolbarSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerToolbar.tsx", import.meta.url),
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
    expect(chatWorkspaceSource).toContain("<ProviderMaintenanceNotice");
    expect(chatWorkspaceSource).toMatch(
      /<div ref=\{composerRegionRef\} className="composer-region">[\s\S]*?<Composer[\s\S]*?\/>\s*<\/div>\s*<\/Root>/u,
    );
    expect(`${composerSource}\n${inputSource}\n${toolbarSource}`).not.toMatch(
      /composer-(?:footer|note|helper|usage-strip|spacer)/u,
    );
  });

  it("keeps contextual content inside the dock instead of reserving a lower row", () => {
    const dockStart = composerSource.indexOf("<section");
    const dockEnd = composerSource.indexOf("</section>", dockStart);
    const dock = composerSource.slice(dockStart, dockEnd);

    for (const marker of [
      "<ComposerInputZone",
      "<ComposerToolbar",
    ]) {
      expect(dock, marker).toContain(marker);
    }
    for (const marker of [
      'className="provider-readiness"',
      "<ComposerAttachmentList",
      'className="composer-attachment-boundary"',
    ]) {
      expect(inputSource, marker).toContain(marker);
    }
    expect(inputSource).toContain('? "Add a follow-up while the agent works…"');
    expect(toolbarSource).toContain('className="secondary-button composer-follow-up-button"');
    expect(toolbarSource).toContain('className="composer-follow-up-unavailable"');
    expect(toolbarSource).toContain("<UsageIndicator");
  });

  it("uses anchored or hidden usage modes without a permanent detail strip", () => {
    for (const mode of ["hidden", "compact", "expanded"] as const) {
      expect(usageDisplayBehavior(mode).showPermanentStrip).toBe(false);
    }
    expect(usageDisplayBehavior("hidden").surface).toBe("hidden");
    expect(usageDisplayBehavior("compact").surface).toBe("circle");
    expect(usageDisplayBehavior("expanded").surface).toBe("circle-with-value");
  });

  it("keeps only a small semantic breathing room below the dock at every breakpoint", () => {
    const shellRules = [...css.matchAll(
      /\.composer-shell\s*\{(?<body>[^}]*)\}/gu,
    )].map((match) => match.groups?.body ?? "");

    expect(shellRules).toHaveLength(2);
    expect(shellRules).toEqual(expect.arrayContaining([
      expect.stringContaining("padding: 7px clamp(18px, 4vw, 54px) var(--composer-bottom-breathing-room)"),
      expect.stringContaining("padding: 7px 9px var(--composer-bottom-breathing-room)"),
    ]));
    expect(css).toContain("--composer-bottom-breathing-room: 10px");
    expect(css).toMatch(
      /\.app-shell\.platform-(?:linux|win32)\s*\{[^}]*--composer-bottom-breathing-room:\s*12px/su,
    );
  });
});
