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

describe("project-row quick New chat action", () => {
  it("reuses the project-scoped creation callback without toggling or copying chat state", () => {
    const quickAction = sidebarSource.match(
      /<IconButton\s+label=\{`New chat in \$\{project\.name\}`\}(?<body>[\s\S]*?)<\/IconButton>/u,
    )?.groups?.body ?? "";

    expect(quickAction).toContain('className="project-new-chat-button"');
    expect(quickAction).toContain('disabled={connectionStatus !== "online"}');
    expect(quickAction).toContain("event.stopPropagation()");
    expect(quickAction).toContain("setConversationMenu(null)");
    expect(quickAction).toContain("setProjectMenu(null)");
    expect(quickAction).toContain("onCreateConversation(project)");
    expect(quickAction).not.toContain("onSelectProject");
    expect(quickAction).not.toContain("message.send");
  });

  it("places the quick action immediately before overflow using the existing icon system", () => {
    const quickActionIndex = sidebarSource.indexOf("label={`New chat in ${project.name}`}");
    const overflowIndex = sidebarSource.indexOf(
      "label={`Project actions for ${project.name}`}",
      quickActionIndex,
    );

    expect(quickActionIndex).toBeGreaterThan(-1);
    expect(overflowIndex).toBeGreaterThan(quickActionIndex);
    expect(sidebarSource.slice(quickActionIndex, overflowIndex)).toContain(
      "<SquarePen size={13} />",
    );
  });

  it("keeps both controls compact, revealable by hover or focus, and out of layout flow", () => {
    expect(styles).toMatch(
      /\.project-row-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*display:\s*flex;/su,
    );
    expect(styles).toMatch(
      /\.project-new-chat-button,\s*\.project-menu-button\s*\{[^}]*width:\s*24px;[^}]*height:\s*30px;[^}]*opacity:\s*0;/su,
    );
    expect(styles).toMatch(
      /\.project-row:hover \.project-new-chat-button,[\s\S]*?\.project-row:focus-within \.project-new-chat-button,[\s\S]*?\.project-new-chat-button:focus-visible,[\s\S]*?\{[^}]*opacity:\s*1;/u,
    );
    expect(styles).toMatch(
      /\.project-select\s*\{[^}]*padding:\s*0 50px 0 0;/su,
    );
  });
});
