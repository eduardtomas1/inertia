import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(
  new URL("../../src/renderer/src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

describe("classic sidebar current-state presentation", () => {
  it("exposes the active project and chat without relying on color alone", () => {
    expect(sidebarSource).toContain(
      'aria-current={isActive && view === "workspace"',
    );
    expect(sidebarSource).toContain(
      "aria-current={snapshot?.activeConversationId === conversation.id",
    );
    expect(sidebarSource).toContain(
      "aria-label={`Project status: ${project.status}`}",
    );
    expect(sidebarSource).toContain(
      "aria-label={`Chat status: ${statusLabels[thread.status]}`}",
    );
    expect(styles).toMatch(
      /\.project-row\.is-active\s*\{[^}]*background:\s*transparent;/su,
    );
    expect(styles).toMatch(
      /\.project-row\.is-active \.project-name\s*\{[^}]*font-weight:\s*680;/su,
    );
    expect(styles).toMatch(
      /\.conversation-row\.is-active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--surface-hover\) 72%, transparent\);/su,
    );
    expect(styles).not.toMatch(/\.project-row\.is-active\s*\{[^}]*box-shadow:/su);
    expect(styles).not.toMatch(/\.conversation-row\.is-active\s*\{[^}]*box-shadow:/su);
  });
});
