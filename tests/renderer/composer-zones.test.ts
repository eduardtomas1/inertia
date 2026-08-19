import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const inputSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerInputZone.tsx", import.meta.url),
  "utf8",
);
const toolbarSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);
const autosizeSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/useTextareaAutosize.ts", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("composer input and control zones", () => {
  it("keeps previews, readiness, route confirmation, and textarea in one input zone", () => {
    const inputStart = inputSource.indexOf(
      'className="composer-input-zone"',
    );
    const inputEnd = inputSource.indexOf("</div>", inputSource.indexOf(
      "!messageFits",
      inputStart,
    ));
    const controlsStart = toolbarSource.indexOf(
      'className="composer-toolbar"',
    );
    const inputZone = inputSource.slice(inputStart, inputEnd);

    expect(inputStart).toBeGreaterThan(-1);
    expect(inputEnd).toBeGreaterThan(inputStart);
    expect(controlsStart).toBeGreaterThan(-1);
    expect(inputZone).toContain('data-composer-zone="input"');
    expect(inputZone).toContain('className="provider-readiness"');
    expect(inputZone).toContain('className="composer-context"');
    expect(inputZone).toContain("<ComposerAttachmentList");
    expect(inputZone).toContain("<RouteChangeConfirmation");
    expect(inputZone).toContain('aria-label="Message"');
    expect(toolbarSource.slice(controlsStart)).toContain("composer-tools");
  });

  it("drives zone spacing, scale, density, and readability through semantic tokens", () => {
    for (const token of [
      "--composer-input-padding-inline",
      "--composer-input-padding-block",
      "--composer-control-padding-inline",
      "--composer-control-padding-block",
      "--composer-zone-gap",
      "--composer-density-spacing-adjustment",
      "--composer-zone-separator",
      "--composer-preview-size",
    ]) {
      expect(css).toContain(`${token}:`);
    }

    for (const scale of ["compact", "comfortable", "large"]) {
      const block = css.match(
        new RegExp(
          `:root\\[data-interface-scale="${scale}"\\]\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
          "u",
        ),
      )?.groups?.body ?? "";
      expect(block).toContain("--composer-input-padding-inline:");
      expect(block).toContain("--composer-input-padding-block:");
      expect(block).toContain("--composer-control-padding-inline:");
      expect(block).toContain("--composer-control-padding-block:");
    }

    expect(css).toMatch(
      /\.chat-workspace\.response-density-compact \.composer\s*\{[^}]*--composer-density-spacing-adjustment:\s*-1px/su,
    );
    expect(css).toMatch(
      /\.chat-workspace\.response-density-comfortable \.composer\s*\{[^}]*--composer-density-spacing-adjustment:\s*1px/su,
    );
    expect(css).toMatch(
      /\.composer textarea\s*\{[^}]*font-size:\s*calc\(var\(--ui-font-main\) \+ var\(--platform-readability-adjustment\)\)/su,
    );
    expect(css).not.toMatch(
      /\.composer textarea\s*\{[^}]*transition:\s*height/su,
    );
    expect(autosizeSource).toContain("new ResizeObserver");
    expect(autosizeSource).toContain("observer.observe(textarea)");
    expect(autosizeSource).toContain("observer.disconnect()");
  });

  it("uses one quiet separator and consistent toolbar control geometry", () => {
    expect(css).toMatch(
      /\.composer\s*\{[^}]*padding:\s*0;[^}]*background:\s*var\(--composer-surface\)/su,
    );
    expect(css).toMatch(
      /\.composer-input-zone\s*\{[^}]*display:\s*grid;[^}]*gap:\s*calc\(var\(--composer-zone-gap\) \+ var\(--composer-density-spacing-adjustment\)\);[^}]*padding:[^}]*var\(--composer-input-padding-inline\)/su,
    );
    expect(css).toMatch(
      /\.composer-toolbar\s*\{[^}]*padding:[^}]*var\(--composer-control-padding-inline\);[^}]*border-top:\s*1px solid var\(--composer-zone-separator\)/su,
    );
    expect(css).toMatch(
      /\.composer-toolbar \.icon-button,[\s\S]*?\.composer-toolbar \.usage-popover-trigger\s*\{[^}]*height:\s*var\(--composer-control-height\);[^}]*min-height:\s*var\(--composer-control-height\)/su,
    );
    expect(css).toMatch(
      /\.send-button\s*\{[^}]*flex:\s*0 0 var\(--composer-control-height\);[^}]*margin-left:\s*4px/su,
    );
    expect(css).not.toMatch(
      /@media \(max-width:\s*1180px\)[\s\S]*?\.access-control\s*\{[^}]*display:\s*none/su,
    );
    expect(css).toMatch(
      /@container \(max-width:\s*720px\)[\s\S]*?\.composer-setting-family\s*\{[^}]*display:\s*none[\s\S]*?\.composer-more-control\s*\{[^}]*display:\s*block/su,
    );
  });

  it("shows truthful provider chat-tool support without crowding narrow composers", () => {
    expect(toolbarSource).toContain("selectedProvider.agentThreadManagement.state");
    expect(toolbarSource).toContain("Agent chat tools:");
    expect(toolbarSource).toContain("<MessagesSquare");
    expect(css).toMatch(
      /\.composer-agent-thread-capability\.is-supported\s*\{[^}]*color:\s*var\(--accent-strong\)/su,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[^}]*\.composer-agent-thread-capability > span\s*\{[^}]*display:\s*none/su,
    );
  });

  it("integrates previews and notices without nested card surfaces", () => {
    for (const selector of [
      "composer-attachment",
      "composer-context",
      "composer-route-confirmation",
      "provider-readiness",
    ]) {
      const block = css.match(
        new RegExp(`\\.${selector}\\s*\\{(?<body>[^}]*)\\}`, "u"),
      )?.groups?.body ?? "";
      expect(block, selector).toContain("background: transparent");
    }

    expect(css).toMatch(
      /\.composer-attachment\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-small\)/su,
    );
    expect(css).toMatch(
      /\.composer-attachment-preview\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--border\)/su,
    );
    expect(css).toMatch(
      /\.composer-attachment:hover\s*\{[^}]*background:\s*color-mix/su,
    );
    expect(css).toMatch(
      /\.composer-attachment-remove:focus-visible\s*\{[^}]*outline:\s*2px solid/su,
    );
    expect(css).toMatch(
      /\.selected-model-chip:disabled\s*\{[^}]*opacity:\s*0\.62/su,
    );
    expect(css).toMatch(
      /\.usage-popover-trigger:hover,[\s\S]*?\.usage-popover-trigger\.is-open\s*\{[^}]*background:\s*var\(--surface-hover\)/su,
    );
  });
});
