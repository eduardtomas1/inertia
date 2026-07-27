import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const chooserSource = readFileSync(
  new URL("../../src/renderer/src/components/ModelChooser.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../../src/renderer/src/utils/modelChooserRoutes.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../../src/renderer/src/components/ChatWorkspace.tsx", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../../src/renderer/src/components/ModelBackendsSettings.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("anchored composer model chooser", () => {
  it("projects exact harness/backend/model routes into one chooser", () => {
    expect(composerSource).toContain("<ModelChooser");
    expect(composerSource).toContain("selectedModelSearchRoute");
    expect(chooserSource).toContain("<ModelSourceRail");
    expect(chooserSource).toContain("<ModelChooserRow");
    expect(routeSource).toContain("backendProfileDisplayName");
    expect(routeSource).toContain("continuationIdentityForSelection");
    expect(routeSource).not.toContain("endpointHost");
    expect(routeSource).not.toContain("credentialGeneration");
  });

  it("uses the latest turn identity and requires an explicit new chat at a boundary", () => {
    expect(composerSource).toContain("selection: latestTurn.modelSelection");
    expect(composerSource).toContain("resolveModelRouteTransition");
    expect(composerSource).toContain('role="alertdialog"');
    expect(composerSource).toContain("New chat");
    expect(workspaceSource).not.toContain("providerLocked");
    expect(workspaceSource).not.toContain("messages.length > 0");
  });

  it("exposes the full backend settings editor and deliberate narrow layouts", () => {
    expect(settingsSource).toContain("New chat defaults");
    expect(settingsSource).toContain("Test connection");
    expect(settingsSource).toContain("Edit configuration");
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.backend-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.backend-profile-rail\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto/u);
    expect(css).toMatch(/@media \(max-width:\s*560px\)[\s\S]*?\.backend-identity-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    expect(css).toMatch(/@media \(max-width:\s*560px\)[\s\S]*?\.backend-secret-row input\s*\{[^}]*width:\s*100%/u);
    expect(css).toMatch(/\.model-chooser-palette\s*\{[^}]*bottom:\s*calc\(100% \+ 9px\)/u);
    expect(css).toMatch(/@container \(max-width:\s*480px\)[\s\S]*?\.model-chooser-palette\s*\{[^}]*width:\s*min\(calc\(100vw - 18px\),\s*calc\(100cqw - 14px\)\)/u);
  });
});
