import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/Composer.tsx", import.meta.url),
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

describe("grouped backend composer picker", () => {
  it("groups models under harness and backend identities", () => {
    expect(composerSource).toContain("composer-backend-group");
    expect(composerSource).toContain("composer-backend-profile");
    expect(composerSource).toContain("backendProfileDisplayName");
    expect(composerSource).toContain("modelSelectionIdentityLabel");
  });

  it("uses the latest turn identity and requires an explicit new chat at a boundary", () => {
    expect(composerSource).toContain("latestTurn?.modelSelection");
    expect(composerSource).toContain("resolveContinuationDecision");
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
  });
});
