import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/Composer.tsx", import.meta.url),
  "utf8",
);
const inputSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerInputZone.tsx", import.meta.url),
  "utf8",
);
const commandMenuSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerCommandMenu.tsx", import.meta.url),
  "utf8",
);
const toolbarSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);
const queuedActionsSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerQueuedActions.tsx", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerSettings.tsx", import.meta.url),
  "utf8",
);
const routeConfirmationSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/RouteChangeConfirmation.tsx", import.meta.url),
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

describe("cohesive composer dock", () => {
  it("keeps input, previews, route readiness, and controls in one labelled surface", () => {
    const shellStart = composerSource.indexOf('<div className="composer-shell">');
    const composerStart = composerSource.indexOf("<section", shellStart);
    const composerEnd = composerSource.indexOf("</section>", composerStart);
    const dock = composerSource.slice(composerStart, composerEnd);

    expect(shellStart).toBeGreaterThan(-1);
    expect(composerStart).toBeGreaterThan(shellStart);
    expect(dock).toContain('aria-label="Message composer"');
    expect(dock).toContain("aria-busy={");
    expect(dock).toContain("|| conversationUpdatePending");
    expect(dock).toContain("<ComposerInputZone");
    expect(dock).toContain("<ComposerToolbar");
    expect(dock.indexOf("<ComposerInputZone"))
      .toBeLessThan(dock.indexOf("<ComposerToolbar"));
    expect(inputSource).toContain('data-composer-zone="input"');
    expect(toolbarSource).toContain('className="composer-toolbar"');
    expect(inputSource).toContain('className="provider-readiness"');
    expect(inputSource).toContain("<ComposerAttachmentList");
    expect(inputSource).not.toContain(
      'className="composer-attachment-boundary"',
    );
    expect(inputSource).toContain('aria-label="Message"');
    expect(toolbarSource).toContain('className="composer-toolbar"');
    expect(toolbarSource).toContain('role="group"');
    expect(toolbarSource).toContain('aria-label="Composer controls"');
    expect(inputSource.indexOf('className="provider-readiness"'))
      .toBeLessThan(inputSource.indexOf('aria-label="Message"'));
    expect(inputSource.indexOf("<ComposerAttachmentList"))
      .toBeLessThan(inputSource.indexOf('aria-label="Message"'));
    expect(composerSource).not.toContain("composer-footer");
    expect(composerSource).not.toContain("composer-note");
  });

  it("preserves the integrated control order and compact overflow priority", () => {
    const toolbarStart = toolbarSource.indexOf(
      'className="composer-toolbar"',
    );
    const toolbar = toolbarSource.slice(toolbarStart);
    const controlOrder = [
      "<ModelChooser",
      "<ComposerSettings",
      "<ComposerMoreMenu",
      "<UsageIndicator",
      "<ComposerSendActions",
    ].map((marker) => toolbar.indexOf(marker));

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(controlOrder.every((position) => position >= 0)).toBe(true);
    expect(controlOrder).toEqual([...controlOrder].sort((a, b) => a - b));
    expect(settingsSource.indexOf("composer-reasoning-control"))
      .toBeLessThan(settingsSource.indexOf("composer-access-control"));
    expect(settingsSource.indexOf("composer-access-control"))
      .toBeLessThan(settingsSource.indexOf("composer-mode-control"));
    expect(css).toMatch(
      /@container \(max-width:\s*820px\)\s*\{[\s\S]*?\.composer-action-control,[\s\S]*?\.composer-setting-family\s*\{[^}]*display:\s*none/su,
    );
    expect(css).toMatch(
      /@container \(max-width:\s*820px\)\s*\{[\s\S]*?\.composer-more-control\s*\{[^}]*display:\s*block/su,
    );
    expect(css).toMatch(
      /\.composer-tools,[\s\S]*?\.composer-options,[\s\S]*?\.composer-actions\s*\{[^}]*min-width:\s*0;[^}]*gap:\s*3px/su,
    );
    expect(css).toMatch(
      /\.composer-usage\s*\{[^}]*flex:\s*0 0 auto/su,
    );
    expect(css).toMatch(
      /\.send-button\s*\{[^}]*flex:\s*0 0 var\(--composer-control-height\)/su,
    );
  });

  it("uses a restrained opaque, centered surface across scale and theme tokens", () => {
    expect(css).toContain("--composer-surface: var(--surface-strong);");
    expect(css).toMatch(
      /\.composer\s*\{[^}]*max-width:\s*var\(--composer-max-width\);[^}]*margin:\s*0 auto;[^}]*border:\s*1px solid var\(--composer-border\);[^}]*border-radius:\s*var\(--radius-composer\);[^}]*background:\s*var\(--composer-surface\);[^}]*box-shadow:\s*var\(--composer-shadow\);/su,
    );
    const composerRule = css.match(
      /\.composer\s*\{(?<body>[^}]*)\}/u,
    )?.groups?.body ?? "";
    const composerShadow = css.match(
      /--composer-shadow:\s*(?<body>[\s\S]*?);/u,
    )?.groups?.body ?? "";

    expect(composerRule).not.toContain("backdrop-filter");
    expect(composerShadow).not.toContain("--glass-inset");
    expect(css).toMatch(
      /:root\[data-interface-scale="compact"\]\s*\{[^}]*--composer-max-width:\s*760px/su,
    );
    expect(css).toContain("--composer-max-width: 860px;");
    expect(css).toMatch(
      /:root\[data-interface-scale="comfortable"\]\s*\{[^}]*--composer-max-width:\s*900px/su,
    );
    expect(css).toMatch(
      /:root\[data-interface-scale="large"\]\s*\{[^}]*--composer-max-width:\s*940px/su,
    );
    expect(css).toMatch(
      /\.provider-readiness\s*\{[^}]*min-width:\s*0;[^}]*margin:\s*0;[^}]*border-bottom:\s*1px solid var\(--composer-zone-separator\);[^}]*background:\s*transparent/su,
    );
  });

  it("retains multiline, attachment, route, mention, slash, and keyboard behavior", () => {
    expect(css).toMatch(
      /\.composer textarea\s*\{[^}]*min-height:\s*clamp\(44px, 7cqh, 60px\);[^}]*max-height:\s*176px;[^}]*resize:\s*none;[^}]*overflow-y:\s*auto/su,
    );
    expect(css).not.toMatch(
      /\.composer textarea\s*\{[^}]*transition:\s*height/su,
    );
    expect(autosizeSource).toContain('textarea.style.height = "0px"');
    expect(autosizeSource).toContain(
      "Math.min(contentHeight, MAX_TEXTAREA_HEIGHT_PX)",
    );
    expect(autosizeSource).toContain(
      "textarea.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT_PX",
    );
    expect(inputSource).toContain("if (shouldSubmitComposerKey(event))");
    expect(queuedActionsSource).toContain('className="composer-queue"');
    expect(queuedActionsSource).toContain('aria-label="Send queued message now"');
    expect(composerSource).toContain('event.dataTransfer.types.includes("Files")');
    expect(inputSource).toContain("event.clipboardData.files.length > 0");
    expect(inputSource).toContain('aria-label="Project files"');
    expect(commandMenuSource).toContain('aria-label="Composer commands"');
    expect(routeConfirmationSource).toContain('role="alertdialog"');
    expect(composerSource).not.toContain("documentAttachmentSendBoundary");
  });
});
