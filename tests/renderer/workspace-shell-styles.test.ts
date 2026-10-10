import { describe, expect, it } from "vitest";

import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

function block(selector: string, source = css): string {
  const start = source.indexOf(`\n${selector} {\n`);
  expect(start, selector).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start + 1));
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
    expect(css).not.toMatch(/\.file-(language|location) \{[^}]*(accent|!important)/u);
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
