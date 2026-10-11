import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

function block(selector: string, source = css): string {
  const pattern = new RegExp(`(?:^|[}\\n]\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{\\n`, "u");
  const match = pattern.exec(source);
  expect(match, selector).not.toBeNull();
  const start = match!.index + match![0].length;
  return source.slice(start, source.indexOf("\n}", start));
}

describe("workspace panel launcher", () => {
  it("hovers on --fill, highlights on --fill-strong and dims unavailable rows to the shared opacity", () => {
    expect(block(".workspace-panel-launcher-list > button:hover")).toContain("background: var(--fill);");
    expect(block(".workspace-panel-launcher-list > button.is-highlighted")).toContain("background: var(--fill-strong);");
    expect(block(".workspace-panel-launcher-list > .is-unavailable")).toContain("opacity: var(--disabled-opacity);");
  });

  it("keeps menu hints and loading lines in muted text, not the warning colour", () => {
    const hint = block(".header-menu-hint-text");
    expect(hint).toContain("color: var(--text-muted);");
    expect(hint).not.toContain("--warning");
  });
});

const motion = readSourceText("src/renderer/src/components/BeautifulUiMotion.css");

describe("changes panel", () => {
  it("selects rows on --fill-strong with the name at 500 and rests names at 400", () => {
    expect(block(".workspace-repository-files > li:has(.workspace-repository-file.is-selected)")).toContain("background: var(--fill-strong);");
    expect(block(".workspace-repository-file-copy strong")).toContain("font-weight: 400;");
    expect(block(".workspace-repository-file.is-selected .workspace-repository-file-copy strong")).toContain("font-weight: 500;");
    expect(css).toContain(".change-file-name, .file-entry-name { overflow: hidden; font-weight: 400;");
    expect(block(".change-file-button,\n.file-entry")).toContain("min-height: 36px;");
    expect(block(".change-file-button.is-selected,\n.file-entry.is-selected")).toContain("background: var(--fill-strong);");
  });

  it("sizes the Git row buttons as small chrome buttons and keeps the repository icon neutral", () => {
    const button = block(".workspace-repository-scope-actions > button");
    expect(button).toContain("height: var(--control-height-small);");
    expect(button).toContain("font-size: var(--text-sm);");
    expect(button).toContain("font-weight: 500;");
    expect(block(".workspace-repository-scope-leading > svg")).toContain("color: var(--text-muted);");
  });

  it("draws diffs at the diff size without accent hunk headers, accent buttons or a progress bar", () => {
    expect(block(".diff-code,\n.file-preview-code")).toContain("font-size: var(--text-diff);");
    expect(css).not.toMatch(/\.diff-hunk-header \{[^}]*accent/u);
    expect(css).not.toMatch(/\.diff-line\.is-hunk \{[^}]*accent/u);
    expect(css).not.toMatch(/\.diff-hunk-actions button \{[^}]*accent/u);
    expect(css).not.toMatch(/is-reviewed \{[^}]*accent/u);
    expect(css).not.toContain(".diff-review-toolbar progress");
    expect(css).not.toMatch(/\.diff-review-toolbar \{[^}]*background/u);
    expect(css).not.toContain("filter: brightness(0.98)");
    expect(css).toContain(".diff-code .diff-line.is-selected { background-image: linear-gradient(var(--fill-strong), var(--fill-strong)); }");
  });

  it("shows the review filter as plain buttons with --fill-strong for the pressed one", () => {
    expect(motion).toContain('.diff-review-filter button[aria-pressed="true"] { color: var(--text); background: var(--fill-strong); }');
    expect(motion).not.toMatch(/\.diff-review-filter[^{]*\{[^}]*accent/u);
    expect(motion).not.toMatch(/\.diff-review-filter \{[^}]*border/u);
  });

  it("puts the diff selection popover on the shared popover base", () => {
    expect(css).toMatch(/\.diff-selection-popover \{[^}]*padding: 4px; border: 1px solid var\(--line-soft\);/u);
    expect(css).not.toMatch(/\.diff-reversal-scope \{[^}]*border/u);
    expect(css).toMatch(/\.diff-selection-popover textarea \{[^}]*font: var\(--text-sm\)/u);
  });

  it("rings diff line buttons inside the row", () => {
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    expect(inset).toContain(".diff-code .diff-line");
  });

  it("keeps changed-file and tree icons neutral", () => {
    expect(block(".file-entry > svg.file-language-icon,\n.change-file-button .file-language-icon,\n.workspace-repository-file .file-language-icon")).toContain("color: var(--text-muted);");
  });

  it("keeps the panel toolbar on the 4px grid with one chrome text size", () => {
    expect(block(".panel-toolbar")).toContain("min-height: 48px;");
    expect(css).toContain(".panel-heading-copy h2 { margin: 0; font-size: var(--text-sm); font-weight: 500; }");
  });
});

describe("files panel", () => {
  const badge = readSourceText("src/renderer/src/components/FileGitBadge.css");

  it("keeps tree rows at the 36px list height and the file language and location in muted text", () => {
    expect(block(".file-entry-list .file-entry")).toContain("min-height: 36px;");
    const label = block(".file-language,\n.file-location");
    expect(label).toContain("color: var(--text-muted);");
    expect(css).not.toMatch(/\.file-(language|location) \{[^}]*accent/u);
    expect(block(".file-preview-line.is-referenced .file-preview-line-number")).not.toContain("accent");
  });

  it("presses the explorer toggle and Markdown view on --fill-strong without accent or a framed segment", () => {
    expect(block('.file-explorer-toggle[aria-pressed="true"]')).toContain("background: var(--fill-strong);");
    expect(block('.file-explorer-toggle[aria-pressed="true"]')).not.toContain("accent");
    expect(block('.file-preview-view-toggle button[aria-pressed="true"]')).toContain("background: var(--fill-strong);");
    expect(block(".file-preview-view-toggle")).not.toContain("border");
  });

  it("drops the gradient behind Markdown previews and the empty heading rule", () => {
    expect(block(".file-preview-markdown")).not.toContain("gradient");
    expect(css).not.toContain(".file-preview-markdown .response-markdown h1:first-child {\n}");
  });

  it("aligns the preview header and search row on the 4px grid", () => {
    expect(block(".file-search-wrap")).toContain("height: 40px;");
    expect(block(".files-layout.is-explorer-open")).toContain("grid-template-rows: 40px minmax(0, 1fr);");
    expect(badge).toContain("font-weight: 500;");
  });
});

describe("browser panel", () => {
  const evidence = readSourceText("src/renderer/src/components/BrowserEvidenceTimeline.css");

  it("frames the address with --line, has no accent loading sweep and keeps evidence free of accent", () => {
    expect(css).toMatch(/\.preview-address-form \{[^}]*border: 1px solid var\(--line\);[^}]*background: transparent;/u);
    expect(css).not.toContain(".preview-loading-bar");
    expect(evidence).not.toContain("accent");
    expect(evidence).not.toContain("browser-evidence-entry-icon");
  });
});

describe("interface scale layer", () => {
  it("scales the review controls from the small control height and leaves the toolbar count at chrome size", () => {
    const scale = css.slice(css.indexOf(" * Interface scale is a semantic layer"));
    expect(block(".diff-review-toolbar", scale)).toContain("min-height: calc(var(--ui-control-height) + 8px);");
    expect(block(".diff-review-toolbar select,\n.diff-file-review-heading button,\n.diff-hunk-actions button,\n.diff-review-note > button,\n.diff-selection-actions > button,\n.diff-selection-popover .primary-button", scale)).toContain("min-height: var(--control-height-small);");
    expect(block(".change-file-button,\n.file-entry", scale)).toContain("min-height: max(36px, calc(var(--ui-control-height) + 4px));");
    expect(scale).not.toContain(".panel-heading-copy span,");
  });
});

describe("terminal", () => {
  it("shows overlay and empty-state glyphs plain, without an accent tile", () => {
    const tile = block(".palette-empty > svg:first-child,\n.sidebar-empty > svg:first-child,\n.terminal-overlay > svg:first-child");
    expect(tile).toContain("color: var(--text-muted);");
    expect(tile).not.toContain("border");
    expect(tile).not.toContain("accent");
    expect(block(".terminal-overlay")).toContain("font-size: var(--text-sm);");
  });

  it("keeps split headers on the grid with a quiet title", () => {
    expect(block(".terminal-header")).toContain("min-height: 40px;");
    expect(block(".terminal-title")).toContain("font-weight: 400;");
    expect(css).not.toContain(".terminal-project");
  });

  it("draws the resume bar and its picker on neutral tokens", () => {
    const bar = block(".terminal-resume-status");
    expect(bar).not.toContain("background");
    expect(block(".terminal-resume-status > svg")).toContain("color: var(--text-muted);");
    expect(block(".terminal-resume-trigger:disabled")).toContain("opacity: var(--disabled-opacity);");
    expect(block(".terminal-resume-trigger")).toContain("height: var(--control-height-small);");
    expect(block(".terminal-resume-popover")).toContain("width: min(380px, calc(100% - 16px));");
    expect(block(".terminal-resume-popover")).not.toContain("padding: 0;");
    expect(block('.resume-picker-list button[data-active="true"]')).toContain("background: var(--fill-strong);");
    expect(block('.resume-picker-list button[data-selected="true"] .resume-picker-option-copy strong')).not.toContain("accent");
    expect(block(".resume-picker-list code")).not.toContain("background");
    expect(css).not.toContain(".resume-picker-footer {");
  });
});

describe("plan panel", () => {
  it("lists steps as quiet rows without accent markers, status chips or connector lines", () => {
    expect(css).not.toContain(".plan-progress");
    expect(css).not.toMatch(/\.plan-step-marker\.is-[a-z-]+ \{[^}]*accent/u);
    expect(motion).not.toMatch(/\.plan-step[^{]*\{[^}]*accent/u);
    expect(motion).not.toContain(".plan-step:not(:last-child)::after");
    expect(motion).not.toMatch(/\.plan-step-status \{[^}]*background/u);
    expect(css).toContain(".plan-step.is-active { background: var(--fill-strong); }");
    expect(css).toMatch(/\.plan-document-toggle \{[^}]*border: 1px solid var\(--line\);[^}]*background: transparent;/u);
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    expect(inset).toContain(".plan-step-button");
  });
});

describe("goal panel", () => {
  it("shows goals, notes and empty lines as plain rows without stripes, fills or accent", () => {
    expect(block(".goal-panel-card")).not.toMatch(/border|background/u);
    expect(block(".goal-panel-empty-row,\n.goal-panel-capability-note")).not.toContain("background");
    expect(block(".goal-panel-composer")).not.toContain("border");
    expect(block(".goal-panel-progress > span")).not.toContain("accent");
    expect(block(".goal-panel-skill-copy code")).not.toContain("accent");
    expect(block(".goal-panel-section-heading h3")).toContain("font-weight: 500;");
    expect(css).not.toContain(".goal-panel-toolbar .panel-heading > svg");
    expect(css).not.toContain(".goal-panel-subagent-dot");
    expect(motion).not.toMatch(/\.goal-panel-subagent[^{]*\{[^}]*accent/u);
    expect(motion).not.toMatch(/\.goal-panel-subagent-state \{[^}]*background/u);
    expect(motion).not.toMatch(/\.goal-panel-subagents > li \{[^}]*border/u);
  });
});

describe("goal control in the composer", () => {
  it("drops the accent wash, icon tile, state chip, stripe and boxed current goal", () => {
    expect(block(".chat-goal-control")).not.toMatch(/gradient|accent/u);
    expect(block(".chat-goal-inline > header > span > svg")).not.toMatch(/padding|accent|background/u);
    expect(block(".chat-goal-current")).not.toMatch(/border|background/u);
    expect(block(".chat-goal-current > span")).not.toMatch(/accent|background/u);
    expect(block(".chat-goal-notes")).not.toContain("border");
    expect(block(".chat-goal-actions button:disabled,\n.chat-goal-form > button:disabled,\n.chat-goal-unavailable button:disabled")).toContain("opacity: var(--disabled-opacity);");
    expect(block(".chat-goal-form > button")).toContain("font-weight: 500;");
    expect(block(".chat-goal-form > button:not(:disabled):hover")).toContain("background: var(--accent-hover);");
  });
});

describe("usage, attachments and background task surfaces", () => {
  const surfaces = readSourceText("src/renderer/src/components/WorkspaceSurfaces.css");
  const tasks = readSourceText("src/renderer/src/components/BackgroundTasksSurface.css");

  it("keeps meters, section headings and secondary buttons neutral", () => {
    expect(block(".usage-surface-track > i", surfaces)).not.toContain("accent");
    expect(block(".usage-surface-track", surfaces)).toContain("height: 4px;");
    expect(block(".workspace-surface-heading h3,\n.workspace-surface-section > h3,\n.attachments-surface-gallery .environment-attachments-header h3", surfaces)).toContain("font-size: var(--text-sm);");
    const button = block(".workspace-surface-button", surfaces);
    expect(button).toContain("border: 1px solid var(--line);");
    expect(button).toContain("background: transparent;");
    expect(block(".sent-attachment-thumbnail.is-document")).not.toContain("accent");
    expect(block(".sent-attachment-copy strong")).toContain("font-weight: 500;");
  });

  it("rests the task stop control transparent at the small control size", () => {
    const stop = block(".background-task-stop", tasks);
    expect(stop).toContain("width: var(--control-height-small);");
    expect(stop).toContain("background: transparent;");
    expect(block(".background-task-stop:hover:not(:disabled)", tasks)).toContain("background: var(--fill);");
  });
});

describe("workspace header", () => {
  it("rings toolbar split buttons outside, marks open menus on --fill-strong and draws the rename field with a border", () => {
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    expect(inset).not.toContain(".header-split > button");
    expect(block('.header-split > button[aria-expanded="true"]')).toContain("background: var(--fill-strong);");
    expect(block('.header-split > button[aria-disabled="true"]')).not.toContain("cursor: help");
    expect(css).not.toContain('.header-split > button[aria-disabled="true"] > svg');
    expect(block(".header-title-input")).toContain("border: 1px solid var(--line);");
    expect(block(".header-title-input:focus")).toContain("border-color: var(--accent);");
    expect(css).not.toContain(".header-menu-separator {");
  });
});

describe("Git and branch menus", () => {
  const menus = readSourceText("src/renderer/src/components/workspace-git-menus.css");

  it("uses 28px items, the shared disabled opacity and no boxed counts, cards or accent", () => {
    expect(menus).not.toContain(".git-overview-counts");
    expect(menus).not.toMatch(/opacity: \.52/u);
    expect(menus).toContain('.git-branch-results button[aria-checked="true"] { color: var(--text); font-weight: 500; }');
    expect(menus).not.toMatch(/\.git-branch-error \{[^}]*border/u);
    expect(menus).toMatch(/\.git-action-group > button \{[^}]*min-height: var\(--menu-item-height\);/u);
    expect(css).not.toContain(".branch-current {");
    expect(block(".checkout-context-note")).not.toMatch(/background|line-strong/u);
    expect(block(".checkout-context-note > svg")).not.toContain("accent");
    expect(block(".checkout-context-note > button")).not.toContain("accent");
    expect(block(".new-branch-form input")).toContain("height: var(--control-height-small);");
    expect(block(".new-chat-location-actions > button")).toContain("min-height: var(--menu-item-height);");
    expect(block(".new-chat-location-actions > button:focus-visible")).toContain("background: var(--fill-strong);");
  });
});

describe("checkout branch control", () => {
  it("names a differing checkout in words instead of an accent dot and opens 4px above the trigger", () => {
    const button = readSourceText("src/renderer/src/components/CheckoutBranchMenuButton.tsx");
    expect(button).toContain("contextMismatch ? `Current checkout · ${branch}` : branch");
    expect(button).not.toContain("checkout-context-dot");
    expect(button).toContain("window.innerHeight - bounds.top + 4");
    expect(css).not.toContain(".checkout-context-dot");
    expect(readSourceText("src/renderer/src/components/CheckoutBranchControl.css")).not.toContain("opacity: 0.7");
  });
});

describe("header usage meter", () => {
  it("hovers on --fill with a neutral bar and no trailing hint", () => {
    expect(block(".header-usage-meter:hover")).toContain("background: var(--fill);");
    expect(block(".header-usage-meter-bars > i > b")).not.toContain("accent");
    expect(block(".header-usage-meter")).toContain("height: var(--control-height-small);");
    expect(readSourceText("src/renderer/src/components/workspace-header/HeaderUsageMeter.tsx")).not.toContain("Open Usage for details");
  });
});

describe("sidebar", () => {
  const workIndex = readSourceText("src/renderer/src/sidebar-work-index.css");
  const workbench = readSourceText("src/renderer/src/detached-chat-workbench.css");
  const navigation = readSourceText("src/renderer/src/components/sidebar/workspace-navigation.css");

  it("hovers the brand on --fill and leaves split and detached rows unfilled at rest", () => {
    expect(block(".brand-lockup")).toContain("border-radius: var(--radius-xs);");
    expect(css).toContain(".brand-lockup:hover { background: var(--fill); }");
    expect(block(".platform-darwin .brand-lockup:hover")).toContain("background: var(--fill);");
    expect(workIndex).not.toContain(".activity-thread.is-split:not(.is-active)");
    expect(workbench).not.toContain(".activity-thread.is-detached:not(.is-active) {");
    expect(block(".thread-inline-actions .icon-button", workIndex)).toContain("width: var(--control-height-small);");
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    expect(inset).toContain(".activity-show-more");
  });

  it("renames a project inline without a framed card", () => {
    expect(block(".sidebar-project-rename", navigation)).not.toMatch(/border|background/u);
    const sidebar = readSourceText("src/renderer/src/components/Sidebar.tsx");
    expect(sidebar).not.toContain('"✓"');
    expect(sidebar).not.toContain("Opening your workspace…");
    expect(sidebar).not.toContain("<h3 title={project?.path}>");
  });
});

describe("split view", () => {
  it("draws pane headers at chrome size, drop labels without accent and the drag chip on the floating hairline", () => {
    const header = block(".conversation-split-header");
    expect(header).toContain("font-size: var(--text-sm);");
    expect(block(".conversation-split-header > span:first-of-type")).toContain("font-weight: 500;");
    expect(block(".split-drop-highlight")).not.toContain("accent");
    expect(block(".chat-drag-chip")).toContain("border: 1px solid var(--line-soft);");
  });
});

describe("detached chat window", () => {
  const detached = readSourceText("src/renderer/src/detached-chat.css");

  it("puts project and title on one breadcrumb line and keeps the error bar plain", () => {
    expect(block(".detached-chat-title", detached)).not.toContain("flex-direction: column;");
    expect(block(".detached-chat-title > .detached-chat-project::after", detached)).toContain('content: "/";');
    expect(block(".detached-chat-error", detached)).not.toContain("background");
    const dismiss = block(".detached-chat-error > button", detached);
    expect(dismiss).toContain("border: 1px solid var(--line);");
    expect(dismiss).toContain("font-weight: 500;");
    const app = readSourceText("src/renderer/src/DetachedChatApp.tsx");
    expect(app).toContain("<Pin size={16} />");
    expect(app).not.toContain("Review this request in the main window.");
    expect(readSourceText("src/renderer/src/components/DetachedConversationPlaceholder.tsx")).toContain("{windowOpen ? <PictureInPicture2 size={14} /> : <PanelTopOpen size={14} />}");
  });
});

describe("diff file heading", () => {
  it("wraps its actions below the path before the path truncates", () => {
    expect(css).toContain(".diff-file-review-heading > span { display: flex; min-width: min(12em, 100%); flex: 1 1 12em; flex-direction: column; }");
    expect(css).toMatch(/\.diff-file-review-heading \{[^}]*flex-wrap: wrap;/u);
  });
});
