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

describe("settings nits", () => {
  it("marks an invalid custom colour in danger, keeps short welcome steps scrollable and truncates one-line statuses", () => {
    expect(rule("../../src/renderer/src/components/ThemeLibrary.css", ".custom-theme-inputs input[aria-invalid=\"true\"]")).toContain("border-color: var(--danger);");
    expect(rule("../../src/renderer/src/components/welcome-guide/WelcomeGuide.css", ".welcome-guide-step:is([data-step=\"welcome\"], [data-step=\"start\"])")).toContain("justify-content: safe center;");
    const status = rule(settings, ".setting-status");
    expect(status).toContain("overflow: hidden;");
    expect(status).toContain("text-overflow: ellipsis;");
  });
});

describe("completion sound choices", () => {
  const sound = "../../src/renderer/src/components/notifications/CompletionSoundSettings.css";

  it("fills hover lighter than the selected sound and draws no ring", () => {
    expect(rule(sound, ".completion-sound-choice")).toContain("background: transparent;");
    expect(rule(sound, ".completion-sound-choice:hover:not(:disabled)")).toContain("background: var(--fill);");
    const active = rule(sound, ".completion-sound-choice.is-active");
    expect(active).toContain("background: var(--fill-strong);");
    expect(active).toContain("font-weight: 500;");
    expect(source(sound)).not.toMatch(/var\(--line\)\b|box-shadow/u);
  });
});

describe("project appearance controls", () => {
  const controls = "../../src/renderer/src/components/ProjectAppearanceControls.css";
  const panel = "../../src/renderer/src/components/ProjectCustomizePanel.css";
  const projectSettings = "../../src/renderer/src/components/ProjectSettings.css";

  it("marks the chosen emphasis and icon like other settings choices", () => {
    const emphasis = rule(controls, ".project-emphasis-picker > .project-emphasis-option[aria-checked=\"true\"]");
    expect(emphasis).toContain("background: var(--fill-strong);");
    expect(emphasis).toContain("font-weight: 500;");
    expect(rule(controls, ".project-emphasis-picker")).not.toMatch(/border:|background:/u);
    const icon = rule(controls, ".project-icon-choices > .project-icon-choice[aria-checked=\"true\"]");
    expect(icon).toContain("background: var(--fill-strong);");
    expect(icon).not.toContain("border-color");
  });

  it("keeps swatches still on hover and dims them with the shared opacity", () => {
    expect(source(controls)).not.toMatch(/scale\(1\.08\)|opacity: \.5/u);
    expect(rule(controls, ".project-swatch:disabled")).toContain("opacity: var(--disabled-opacity);");
    expect(rule(controls, ".project-color-well")).toContain("height: var(--control-height-small);");
  });

  it("draws the project chooser as a secondary control and quiet dividers", () => {
    const chooser = rule(projectSettings, ".project-chooser");
    expect(chooser).toContain("border: 1px solid var(--line);");
    expect(chooser).toContain("background: transparent;");
    expect(source(projectSettings)).not.toMatch(/border-top: 1px solid var\(--line\);/u);
  });

  it("fades the customise panel in and labels its sections at chrome size", () => {
    expect(source(panel)).not.toContain("translateX");
    expect(rule(panel, ".project-customize-section h3")).toContain("font-size: var(--text-sm);");
    expect(source(panel)).not.toMatch(/\b(?:11|7|5|3|25|26|30)px/u);
  });
});

describe("agents settings", () => {
  const providers = "../../src/renderer/src/components/settings/ProvidersSettings.css";
  const backends = "../../src/renderer/src/components/ModelBackendsSettings.css";

  it("marks the active provider tab with the selected fill, not an accent underline", () => {
    expect(source(providers)).not.toContain("var(--accent)");
    expect(rule(providers, ".provider-settings-tabs button.is-active")).toContain("background: var(--fill-strong);");
    expect(rule(providers, ".provider-settings-tabs button:hover")).toContain("background: var(--fill);");
  });

  it("uses quiet dividers and chrome sizes inside the provider and backend panes", () => {
    for (const path of [providers, backends]) expect(source(path)).not.toMatch(/solid var\(--line\);/u);
    expect(source(providers)).not.toContain("--text-base");
    expect(source(backends)).not.toContain("--text-base");
    expect(rule(providers, ".provider-settings-maintenance .provider-maintenance-actions > button:not(.icon-button)"))
      .toContain("min-height: var(--control-height-small);");
  });

  it("marks the selected backend and harness with the selected fill and no accent", () => {
    expect(rule(backends, ".backend-profile-rail-item.is-active")).toContain("background: var(--fill-strong);");
    expect(source(backends)).not.toMatch(/var\(--accent/u);
  });
});

describe("devices and integrations", () => {
  it("separates Discord fields and Private Connect blocks like other rows", () => {
    const discord = rule("../../src/renderer/src/components/DiscordSettings.css", ".discord-field");
    expect(discord).toContain("padding: 10px 0;");
    expect(discord).toContain("border-top: 1px solid var(--line-soft);");
    expect(source("../../src/renderer/src/components/ConnectionsAndDevicesSettings.css")).not.toMatch(/solid var\(--line\);/u);
    expect(rule("../../src/renderer/src/components/ConnectionsAndDevicesSettings.css", ".private-connect-projects legend")).toContain("font-size: var(--text-sm);");
  });
});

describe("data section", () => {
  it("separates storage rows like every other settings row", () => {
    const data = "../../src/renderer/src/components/settings/sections/DataSettings.css";
    const row = rule(data, ".attachment-storage-setting > .setting-row");
    expect(row).toContain("border-top: 1px solid var(--line-soft);");
    expect(row).not.toContain("margin-top");
    expect(source(data)).not.toMatch(/solid var\(--line\);|11px/u);
  });
});

describe("help section", () => {
  it("keeps diagnostics dividers quiet and the issue report fields on the shared input", () => {
    const diagnostics = "../../src/renderer/src/components/DiagnosticsSettings.css";
    expect(source(diagnostics)).not.toMatch(/solid var\(--line\);|\b13px\b/u);
    expect(rule(diagnostics, ".diagnostics-section-label")).toContain("font-weight: 500;");
    const issue = "../../src/renderer/src/components/IssueReportSettings.css";
    expect(source(issue)).not.toMatch(/padding: 7px 10px|11px|\bh4\b/u);
  });
});

describe("provider auth dialog contents", () => {
  it("keeps accent off the status icon and the finished state", () => {
    expect(source("../../src/renderer/src/components/ProviderAuthDialog.css")).not.toMatch(/var\(--accent|font-weight: 600/u);
    expect(rule(styles, ".provider-auth-state.is-finished")).toContain("color: var(--status-completed);");
    expect(source(styles)).not.toContain(".provider-auth-mark");
  });
});

describe("welcome and help guides", () => {
  const welcome = "../../src/renderer/src/components/welcome-guide/WelcomeGuide.css";
  const help = "../../src/renderer/src/components/welcome-guide/HelpGuide.css";

  it("draws flat demos, rows instead of cards and an ink progress dot", () => {
    expect(rule(welcome, ".welcome-demo")).not.toMatch(/gradient|accent/u);
    expect(rule(welcome, ".welcome-guide-dots i[data-state=\"current\"]")).toContain("background: var(--text);");
    expect(rule(welcome, ".welcome-guide-tiles li")).not.toMatch(/border:|background:/u);
    expect(rule(welcome, ".welcome-guide-agents li")).not.toMatch(/border:|background:/u);
    expect(rule(help, ".help-guide-entries li,\n.help-guide-result")).not.toMatch(/border:|background:/u);
    expect(rule(welcome, ".welcome-guide-topics button[aria-selected=\"true\"]")).toContain("background: var(--fill-strong);");
  });

  it("marks help search matches with a visible fill, not only a weight the title already has", () => {
    const mark = rule(help, ".help-guide-results mark");
    expect(mark).toContain("color: var(--text);");
    expect(mark).toContain("background: var(--fill);");
  });

  it("draws the compact split demo's sidebar rows as bars, since 12px labels cannot fit their rows", () => {
    expect(rule(welcome, ".welcome-demo.is-compact .d-side")).toContain("color: transparent;");
  });

  it("fades the guide in on opacity alone and sets heading weights", () => {
    for (const name of ["welcome-step-in", "welcome-rise", "welcome-pop"]) {
      expect(new RegExp(`@keyframes ${name} \\{[^@]*?transform`, "u").test(source(welcome)), name).toBe(false);
    }
    expect(rule(welcome, ".welcome-guide h2")).toContain("font-weight: 600;");
    expect(rule(welcome, ".welcome-guide-topic h3")).toContain("font-weight: 600;");
  });
});

describe("mascot overlay", () => {
  const mascot = "../../src/renderer/src/mascot/mascot.css";

  it("never sets text below 12px and fits its four lines in the bubble", () => {
    const sizes = [...source(mascot).matchAll(/font-size:\s*(\d+)px/gu)].map((match) => Number(match[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    const lines = ["mascot-heading", "mascot-chat", "mascot-message", "mascot-footer"].map((name) => {
      const body = rule(mascot, `.${name}`);
      const height = Number(/(?:^|[ ;])height:\s*(\d+)px/u.exec(body)?.[1] ?? /line-height:\s*(\d+)px/u.exec(body)?.[1]);
      const margin = Number(/margin-top:\s*(\d+)px/u.exec(body)?.[1] ?? 0);
      return height + margin;
    });
    expect(lines.reduce((total, line) => total + line, 0)).toBeLessThanOrEqual(116 - 16);
  });

  it("draws the keyboard focus ring in the accent, inset like other rows", () => {
    expect(source(mascot)).not.toContain("#f5ce69");
    expect(source(mascot)).not.toContain("outline-offset: -3px");
    expect(rule(mascot, ".mascot-open:focus-visible, .mascot-picker:focus-visible, .mascot-option:focus-visible")).toContain("outline-offset: -2px;");
  });
});

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
