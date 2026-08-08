import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("../../src/renderer/src/components/SettingsView.tsx", import.meta.url),
  "utf8",
);
const headerSource = readFileSync(
  new URL("../../src/renderer/src/components/WorkspaceHeader.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("quiet settings hierarchy", () => {
  it("avoids repeating decorative headings around the actual settings", () => {
    expect(settingsSource).not.toContain("Make it yours");
    expect(settingsSource).not.toContain(
      "Keep the workspace calm, capable, and predictable.",
    );
    expect(settingsSource).not.toContain("settings-navigation-heading");
    expect(headerSource).not.toContain("Personalize your workspace");
  });

  it("uses flat sections and a neutral toolbar instead of nested cards", () => {
    expect(styles).toMatch(
      /\.settings-toolbar\s*\{[^}]*justify-content:\s*flex-end;[^}]*margin-bottom:\s*16px;/su,
    );
    const cardRule = styles.match(/\.settings-card\s*\{(?<body>[^}]*)\}/u)
      ?.groups?.body ?? "";
    expect(cardRule).not.toContain("border:");
    expect(cardRule).not.toContain("background:");
    expect(cardRule).not.toContain("box-shadow:");
    const rowsRule = styles.match(/\.settings-rows\s*\{(?<body>[^}]*)\}/u)
      ?.groups?.body ?? "";
    expect(rowsRule).not.toContain("border:");
  });
});
