import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/gu, "\n").replace(/\/\*[\s\S]*?\*\//gu, "");
}

function rule(path: string, selector: string): string {
  const css = source(path);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const bodies = [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{(?<body>[^{}]*)\\}`, "gu"))]
    .map((match) => match.groups!.body!);
  expect(bodies.length, `${selector} in ${path}`).toBeGreaterThan(0);
  return bodies.join("\n");
}

const settings = "../../src/renderer/src/components/settings/settings.css";
const search = "../../src/renderer/src/components/settings/SettingsSearch.css";
const styles = "../../src/renderer/src/styles.css";

describe("settings shell rules", () => {
  it("keeps group headings small, muted and medium weight", () => {
    const heading = rule(settings, ".settings-card-heading h3");
    expect(heading).toContain("font-size: var(--text-sm);");
    expect(heading).toContain("font-weight: 500;");
    expect(heading).toContain("color: var(--text-muted);");
    expect(heading).not.toMatch(/text-transform|letter-spacing/u);
  });

  it("gives action rows the same title weight, gap and divider as other rows", () => {
    expect(rule(settings, ".setting-action-row > span > strong")).toContain("font-weight: 400;");
    expect(rule(styles, ".setting-action-row > span")).toContain("gap: 2px;");
    const action = rule(styles, ".runtime-log-setting");
    expect(action).toContain("border-top: 1px solid var(--line-soft);");
    expect(action).toContain("padding: 10px 0;");
    expect(action).not.toContain("margin-top");
  });

  it("draws the select picker as the shared popover", () => {
    expect(rule(settings, ".setting-select::picker(select)")).toContain("border: 1px solid var(--line-soft);");
    expect(rule(settings, ".setting-select option")).toContain("min-height: var(--control-height-small);");
    expect(rule(settings, ".setting-select option:focus-visible")).toContain("background: var(--fill-strong);");
  });

  it("shows fixed keys as plain text, not keycaps", () => {
    const key = rule(settings, ".setting-keys kbd");
    expect(key).toContain("border: 0;");
    expect(key).toContain("color: var(--text-faint);");
  });

  it("lets a long row error wrap at chrome line height", () => {
    const status = rule(settings, ".setting-status");
    expect(status).toContain("line-height: var(--leading-chrome);");
    expect(status).toContain("min-width: 0;");
    expect(rule(settings, ".setting-status.is-error")).toContain("white-space: normal;");
  });

  it("marks the keyboard-active search result like a selected row", () => {
    expect(rule(search, ".settings-search-group > span")).toContain("font-size: var(--text-sm);");
    expect(rule(search, ".settings-search-group button")).toContain("border-radius: var(--radius-xs);");
    expect(rule(search, ".settings-search-group button.is-active")).toContain("background: var(--fill-strong);");
    const mark = rule(search, ".settings-search-group mark");
    expect(mark).toContain("font-weight: 500;");
    expect(mark).toContain("background: transparent;");
  });

  it("keeps the Agents page on the shared settings column", () => {
    expect(source("../../src/renderer/src/components/settings/ProvidersSettings.css")).not.toContain("max-width: 952px");
  });
});
