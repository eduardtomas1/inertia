import { readdirSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IconButton, LoadingMark } from "../../src/renderer/src/components/ui";
import { readSourceText } from "../helpers/source-text";

const css = readSourceText("src/renderer/src/styles.css");

let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement("style");
  sheet.textContent = css.replace(/^@import[^;]*;/mu, "").replace(/\s+/gu, " ");
  document.head.append(sheet);
});

afterAll(() => {
  sheet.remove();
});

function controls(): HTMLButtonElement[] {
  render(
    <div>
      <button type="button" className="primary-button">Save</button>
      <button type="button" className="secondary-button">Cancel</button>
      <button type="button" className="subtle-button">Retry</button>
      <IconButton label="Refresh">R</IconButton>
    </div>,
  );
  return ["Save", "Cancel", "Retry", "Refresh"].map((name) => screen.getByRole("button", { name }));
}

describe("button primitives", () => {
  it("gives every button variant one height, radius, size and weight", () => {
    for (const button of controls()) {
      const style = getComputedStyle(button);
      expect(style.borderRadius, button.className).toBe("6px");
      expect(style.transform, button.className).not.toMatch(/translate/u);
      if (button.classList.contains("icon-button")) {
        expect(style.width).toBe("32px");
        expect(style.height).toBe("32px");
      } else {
        expect(style.minHeight, button.className).toBe("32px");
        expect(style.fontSize, button.className).toBe("13px");
        expect(style.fontWeight, button.className).toBe("500");
      }
    }
  });

  it("paints the primary with the accent and the secondary as a bordered ghost", () => {
    const [primary, secondary, subtle, icon] = controls();
    expect(getComputedStyle(primary!).backgroundColor).toBe(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(getComputedStyle(secondary!).borderTopWidth).toBe("1px");
    for (const ghost of [secondary!, subtle!, icon!]) {
      expect(getComputedStyle(ghost).backgroundColor, ghost.className).toBe("transparent");
      expect(getComputedStyle(ghost).boxShadow, ghost.className).toMatch(/^(?:none)?$/u);
    }
  });

  it("dims native and ARIA disabled buttons with one opacity and a default cursor", () => {
    const [primary, secondary, , icon] = controls();
    primary!.disabled = true;
    secondary!.setAttribute("aria-disabled", "true");
    icon!.disabled = true;
    for (const button of [primary!, secondary!, icon!]) {
      const style = getComputedStyle(button);
      expect(style.opacity, button.className).toBe("0.68");
      expect(style.cursor, button.className).toBe("default");
    }
  });

  it("keeps hover and press feedback off disabled buttons and never lifts", () => {
    expect(css).toMatch(/:is\(\.secondary-button, \.subtle-button, \.text-button, \.icon-button\):hover:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--fill\);/u);
    expect(css).toMatch(/:is\(\.secondary-button, \.subtle-button, \.text-button, \.icon-button\):active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--fill-strong\);/u);
    expect(css).toMatch(/:is\(\.primary-button, \.secondary-button, \.subtle-button, \.text-button, \.icon-button\):active:not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*transform: scale\(0\.97\);/u);
    expect(css).toMatch(/\.primary-button:is\(:hover, :active\):not\(:disabled, \[aria-disabled="true"\]\)\s*\{[^}]*background: var\(--accent-hover\);/u);
    expect(css).not.toMatch(/translateY\(-1px\)/u);
  });
});

describe("focus ring", () => {
  const rendererCss = [
    "styles.css",
    "components/BeautifulUiMotion.css",
    "components/settings/settings.css",
    "components/UsageView.css",
    "components/UsageLimitsPanel.css",
    "components/ThemeLibrary.css",
  ].map((path) => readSourceText(`src/renderer/src/${path}`)).join("\n");

  it("draws one accent ring, outset on controls and inset on rows, tabs and menu items", () => {
    expect(css).toMatch(/^:focus-visible \{\n  outline: 2px solid var\(--focus-ring\);\n  outline-offset: 2px;\n\}/mu);
    const inset = /^:is\(\n(?<list>[\s\S]*?)\n\):focus-visible \{\n  outline-offset: -2px;\n\}/mu.exec(css)?.groups?.list ?? "";
    for (const row of ['[role="menuitem"]', '[role="option"]', '[role="tab"]', ".file-entry", ".workspace-repository-file"]) {
      expect(inset).toContain(row);
    }
  });

  it("leaves no per-component restatement of the ring or its offset", () => {
    const outside = rendererCss.replace(/@media \(forced-colors: active\)[\s\S]*?\n\}\n/gu, "");
    const restated = [...outside.matchAll(/[^{}]*:focus-visible[^{}]*\{[^}]*outline: 2px solid var\(--(?:accent|text)\)/gu)];
    expect(restated.map((match) => match[0].trim())).toEqual([]);
    const offsets = [...outside.matchAll(/outline-offset:\s*(-?\d+)px/gu)].map((match) => match[1]);
    expect(new Set(offsets)).toEqual(new Set(["2", "-2", "6"]));
    const turnOffsets = [...outside.matchAll(/([^{}]*)\{[^}]*outline-offset:\s*6px/gu)].map((match) => match[1]!.trim());
    expect(turnOffsets).toEqual([".response-turn:focus-visible"]);
  });
});

describe("field primitives", () => {
  const composerCss = readSourceText("src/renderer/src/components/composer/ComposerSurface.css");

  it("moves a bordered field from the line to the accent on focus with no glow or ring", () => {
    const fields = /^:is\(\n(?<fields>[\s\S]*?)\n\):focus,\n:is\(\n(?<wraps>[\s\S]*?)\n\):focus-within \{\n(?<body>[\s\S]*?)\n\}/mu.exec(css)?.groups;
    expect(fields?.body).toBe("  outline: none;\n  border-color: var(--accent);\n  box-shadow: none;");
    for (const field of [".setting-input", ".setting-select", ".multi-spawn-field input", ".multi-spawn-prompt-zone textarea"]) {
      expect(fields?.fields).toContain(field);
    }
    expect(readSourceText("src/renderer/src/components/DialogShell.css")).toMatch(/\.dialog-field :is\(input, select, textarea\):focus \{\n  outline: none;\n  border-color: var\(--accent\);\n\}/u);
    expect(fields?.wraps).toContain(".preview-address-form");
    expect(css).not.toMatch(/--shadow-focus|--focus-ring-soft/u);
    expect(css).toMatch(/^::placeholder \{\n  color: var\(--text-muted\);/mu);
  });

  it("keeps the composer flat and only strengthens its border on focus", () => {
    expect(composerCss).toMatch(/\.composer-shell \.composer:focus-within > \.composer-surface \{\n  border-color: var\(--line\);\n\}/u);
    expect(composerCss).toMatch(/\.composer-shell \.composer > \.composer-surface \{[^}]*background: var\(--surface-raised\);[^}]*box-shadow: var\(--shadow-float\);/u);
    expect(`${css}\n${composerCss}`).not.toMatch(/^\.composer(?:-shell \.composer)?:focus-within[^{,]*\{[^}]*(?:--focus-ring|--accent|gradient|box-shadow:(?! none))/mu);
    expect(composerCss).toMatch(/\.composer-shell \.composer textarea \{[^}]*max-height: 200px;/u);
  });
});

describe("popover primitives", () => {
  const surfaces = [".project-menu", ".conversation-menu", ".header-popover", ".composer-popover", ".thread-submenu"];
  const allCss = [
    css,
    readSourceText("src/renderer/src/components/sidebar/thread-actions.css"),
    readSourceText("src/renderer/src/components/composer/ComposerCommandMenu.css"),
    readSourceText("src/renderer/src/components/composer/ComposerSurface.css"),
  ].join("\n");

  function whereRule(member: string, suffix = ""): { list: string; body: string } | undefined {
    for (const match of css.matchAll(/^:where\(\n(?<list>[\s\S]*?)\n\)(?<suffix>[^{\n]*) \{\n(?<body>[\s\S]*?)\n\}/gmu)) {
      const list = match.groups!.list!.split(",\n").map((entry) => entry.trim());
      if (list.includes(member) && match.groups!.suffix === suffix) return { list: list.join("|"), body: match.groups!.body! };
    }
    return undefined;
  }

  it("draws every menu, picker and palette on one raised surface that opens with a fade and slight scale", () => {
    const base = whereRule(".project-menu");
    expect(base?.body).toBe([
      "  padding: 4px;",
      "  border: 1px solid var(--line-soft);",
      "  border-radius: var(--radius-sm);",
      "  color: var(--text);",
      "  background: var(--surface-raised);",
      "  box-shadow: var(--shadow-float);",
      "  transform-origin: top center;",
      "  animation: popover-in var(--dur) var(--ease) backwards;",
    ].join("\n"));
    for (const surface of surfaces) {
      expect(base?.list.split("|"), surface).toContain(surface);
      const escaped = surface.replace(".", String.raw`\.`);
      expect(allCss, surface).not.toMatch(new RegExp(String.raw`(?:^|\n)[^{}\n]*${escaped} \{[^}]*(?:box-shadow|border-radius|background):`, "u"));
    }
    expect(css).toMatch(/@keyframes popover-in \{\n  from \{\n    opacity: 0;\n    transform: scale\(0\.98\);\n  \}\n\}/u);
    expect(base?.list.split("|")).not.toContain(".command-palette");
    expect(whereRule(".dialog-shell")?.list.split("|")).toContain(".command-palette");
    expect(allCss).not.toMatch(/composer-popover-in|workspace-popover-in|palette-panel-in var\(--dur-fast\) var\(--ease\) both;\n\}/u);
  });

  it("offsets the duo dialog's model picker with translate so the shared scale entrance cannot move it", () => {
    const multiSpawn = readSourceText("src/renderer/src/components/MultiSpawnDialog.css");
    const rule = /\n\.multi-spawn-route \.model-chooser-palette \{(?<body>[^}]*)\}/u.exec(multiSpawn)?.groups?.body;
    expect(whereRule(".model-chooser-palette")?.body).toContain("animation: popover-in var(--dur) var(--ease) backwards;");
    expect(rule).toContain("translate: -50% -50%;");
    expect(rule).not.toContain("transform:");
  });

  it("gives menu items one 28px row and highlights keyboard and pointer focus with the same fill and no ring", () => {
    const item = whereRule(".project-menu button", ":is(button)");
    expect(item?.body).toContain("  min-height: var(--menu-item-height);");
    expect(item?.body).toContain("  border-radius: var(--radius-xs);");
    expect(item?.body).toContain("  font-size: var(--text-sm);");
    expect(css).toMatch(/--menu-item-height: calc\(var\(--ui-control-height\) - 4px\);/u);
    for (const menuItem of [".conversation-menu button", ".header-menu-item", ".palette-group button", ".composer-command-list button", ".thread-submenu button"]) {
      expect(item?.list.split("|"), menuItem).toContain(menuItem);
    }
    expect(whereRule(".project-menu button", ':is(:hover, .is-active, [aria-expanded="true"]):not(:disabled, [aria-disabled="true"])')?.body)
      .toBe("  background: var(--fill);");
    expect(whereRule(".project-menu button", '[data-active="true"]:not(:disabled, [aria-disabled="true"])')?.body)
      .toBe("  background: var(--fill-strong);");
    expect(whereRule(".project-menu button", ":focus-visible:not(:disabled, [aria-disabled=\"true\"])")?.body)
      .toBe("  outline: none;\n  background: var(--fill-strong);");
    expect(css).toMatch(/@media \(forced-colors: active\) \{\n  :where\(\n[^{]*\.project-menu button[^{]*\):focus-visible \{\n    outline: 2px solid Highlight;\n    outline-offset: -2px;\n  \}\n\}/u);
    expect(whereRule(".project-menu button", " > svg")?.body).toContain("color: var(--text-muted);");
  });

  it("separates the palette search from its results with one soft rule that keeps its colour while typing", () => {
    expect(css).toMatch(/\n\.palette-search \{\n[^}]*  border-bottom: 1px solid var\(--line-soft\);\n/u);
    expect(css).not.toMatch(/\.palette-search:focus-within \{[^}]*(?:--focus-ring|--accent|border)/u);
  });

  it("separates the model search from its results with the same soft rule and no accent while typing", () => {
    expect(css).toMatch(/\n\.model-chooser-header \{\n[^}]*  border-bottom: 1px solid var\(--line-soft\);\n/u);
    expect(css).not.toMatch(/\.model-chooser-header(?::focus-within)?::after/u);
  });

  it("prints shortcut hints as plain faint text instead of key boxes", () => {
    render(<div className="palette-group"><button type="button">Open <kbd>⌘K</kbd></button></div>);
    const hint = screen.getByText("⌘K");
    expect(getComputedStyle(hint).borderTopWidth).toMatch(/^0(?:px)?$/u);
    expect(getComputedStyle(hint).fontVariantNumeric).toBe("tabular-nums");
    expect(css).not.toMatch(/\.palette-footer kbd \{|\.workspace-panel-launcher kbd \{/u);
  });
});

describe("dialog primitives", () => {
  const componentDialogCss = [
      "components/DialogShell.css",
      "components/AddProjectDialog.css",
      "components/CliConversationImportDialog.css",
      "components/MultiSpawnDialog.css",
      "components/DailyWorkDialog.css",
      "components/composer/SnapshotControl.css",
      "components/composer/ReviewedScreenshotControl.css",
      "components/sidebar/SidebarUpdateControl.css",
      "components/response-timeline/HtmlRenderDialog.css",
      "components/UsageLimitsPanel.css",
      "components/ReviewNoteDialog.css",
      "components/SnapshotAttachment.css",
    ].map((path) => readSourceText(`src/renderer/src/${path}`)).join("\n");
  const dialogCss = `${css}\n${componentDialogCss}\n${readSourceText("src/renderer/src/components/welcome-guide/WelcomeGuide.css")}`;
  const shellCss = readSourceText("src/renderer/src/components/DialogShell.css");

  it("gives every dialog one surface, radius, overlay shadow and title size, without icon tiles", () => {
    const base = /^:where\(\n(?<list>[^)]*)\n\) \{\n(?<body>[^}]*)\n\}/mu.exec(css.slice(css.indexOf("@keyframes dialog-surface-out")))?.groups;
    expect(base?.body).toBe([
      "  border: 1px solid var(--line-soft);",
      "  border-radius: var(--radius-lg);",
      "  color: var(--text);",
      "  background: var(--surface-raised);",
      "  box-shadow: var(--shadow-overlay);",
    ].join("\n"));
    for (const dialog of [".dialog-shell", ".command-palette", ".provider-auth-dialog", ".welcome-guide"]) {
      expect(base?.list, dialog).toContain(dialog);
    }
    expect(css).toMatch(/:where\(\n  \.dialog-shell\n\) h2 \{\n  font-size: var\(--text-md\);\n  font-weight: 600;/u);
    expect(css).not.toMatch(/\.commit-dialog/u);
    expect(dialogCss).not.toMatch(/\.dialog-icon|--scrim\b|--scrim-strong|backdrop-filter: blur\(5px\)|welcome-guide-open|palette-panel-in|multi-spawn-dialog-mark|attachment-preview-close|limits-dialog-close|daily-work-refresh/u);
    expect(dialogCss).not.toMatch(/(?:dialog|preview|review)[\w-]*\s*\{[^}]*border-radius: var\(--radius-(?:sm|md)\)[^}]*box-shadow: var\(--shadow-overlay\)/u);
  });

  it("closes every dialog from one title row and ends it with 32px footer buttons", () => {
    expect(shellCss).toMatch(/\.dialog-shell-header \{[^}]*align-items: flex-start;[^}]*\}/u);
    expect(shellCss).toMatch(/\.dialog-shell-heading > p \{[^}]*overflow-wrap: anywhere;/u);
    expect(shellCss).toMatch(/\.dialog-shell-footer > :is\(\.primary-button, \.secondary-button\) \{\n  min-height: var\(--control-height\);/u);
    expect(shellCss).toMatch(/\.dialog-shell \{\n  display: flex;\n  width: min\(var\(--dialog-width, 480px\), 100%\);/u);
    expect(componentDialogCss).not.toMatch(/min-height: (?:30|34|37|39)px|height: (?:30|37|39)px/u);
  });

  it("dims the window behind dialogs with one backdrop token and no blur", () => {
    expect(css).toMatch(/--backdrop: rgb\(0 0 0 \/ 0\.48\);/u);
    expect(css).toMatch(/:where\(\n  \.dialog-backdrop,\n  \.palette-backdrop\n\),\n\.update-restart-dialog::backdrop \{\n  background: var\(--backdrop\);\n\}/u);
    expect(css).toMatch(/\.dialog-backdrop \{\n  position: fixed;\n  inset: 0;\n  z-index: 105;\n  display: grid;\n  place-items: center;\n  padding: 24px;\n\}/u);
    expect(dialogCss).not.toMatch(/\.(?:snapshot|attachment-preview|multi-spawn|daily-work)-backdrop \{[^}]*(?:padding|place-items)/u);
  });

  it("opens with a fade and slight scale and closes the same way while DialogPresence holds it", () => {
    expect(css).toMatch(/@keyframes dialog-surface-in \{\n  from \{\n    opacity: 0;\n    transform: scale\(0\.98\);/u);
    expect(css).toMatch(/@keyframes dialog-surface-out \{\n  to \{\n    opacity: 0;\n    transform: scale\(0\.98\);/u);
    expect(css).toMatch(/\.dialog-presence\.is-closing > \.dialog-backdrop > \* \{\n    animation: dialog-surface-out/u);
    expect(css).toMatch(/\.dialog-backdrop > \*,[\s\S]*?\{\n    animation: dialog-surface-in var\(--dur\) var\(--ease\) backwards;/u);
    expect(css).toMatch(/  \.dialog-backdrop,\n  \.update-restart-dialog::backdrop \{\n    animation: dialog-veil-in/u);
    expect(css).toMatch(/  \.dialog-backdrop > \*,\n  \.update-restart-dialog \{\n    animation: dialog-surface-in/u);
  });
});

describe("loading primitives", () => {
  function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(?:tsx|ts|css)$/u.test(entry.name) ? [path] : [];
    });
  }

  it("draws one stroked spinner that announces its label or stays decorative", () => {
    render(<div><LoadingMark label="Saving file" /><LoadingMark size={16} aria-hidden="true" /></div>);
    const status = screen.getByRole("status", { name: "Saving file" });
    expect(status.tagName.toLowerCase()).toBe("svg");
    expect(status.getAttribute("stroke-width")).toBe("1.75");
    expect(status).toHaveClass("loading-mark");
    const decorative = document.querySelector('svg.loading-mark[aria-hidden="true"]');
    expect(decorative?.getAttribute("width")).toBe("16");
    expect(decorative).not.toHaveAttribute("role");
    expect(css).toMatch(/\.loading-mark \{\n  display: inline-block;\n  flex: 0 0 auto;\n  animation: spin 800ms linear infinite;\n\}/u);
  });

  it("uses no second spinner, per-word stream spans, blur reveal or pulsing caret", () => {
    const renderer = sources("src/renderer/src").map((path) => readSourceText(path)).join("\n");
    expect(renderer).not.toMatch(/\bLoaderCircle\b|Loader2|provider-status-spinner|response-stream-word|streaming-caret|beautiful-stream-in/u);
    expect(renderer).toMatch(/\.response-stream-block,\n\.response-markdown\.is-streaming:not\(\.is-plain-stream\) > \* \{\n  animation: beautiful-fade-in var\(--dur-slow\) var\(--ease-fade\) both;/u);
    expect(css).toMatch(/animation: turn-thinking-sweep 2200ms/u);
  });
});

describe("toast primitives", () => {
  it("puts toasts and notices on the neutral raised surface and colours only the icon", () => {
    render(
      <div>
        <div className="error-toast" data-testid="error"><svg /><span>Failed</span></div>
        <div className="provider-quota-notice is-5" data-testid="quota"><svg /><span>Low</span></div>
        <div className="database-recovery-notice is-critical" data-testid="recovery"><svg /><span>Recovered</span></div>
      </div>,
    );
    const root = getComputedStyle(document.documentElement);
    for (const id of ["error", "quota", "recovery"]) {
      const style = getComputedStyle(screen.getByTestId(id));
      expect(style.borderRadius, id).toBe("10px");
      expect(style.fontSize, id).toBe("13px");
      expect(style.color, id).toBe(root.getPropertyValue("--text").trim());
    }
    expect(getComputedStyle(screen.getByTestId("error").querySelector("svg")!).color)
      .toBe(root.getPropertyValue("--danger").trim());
    expect(css).toMatch(/^:where\(\.database-recovery-notice, \.error-toast, \.provider-quota-notice\) \{\n  border: 1px solid var\(--line-soft\);\n  border-radius: var\(--radius-sm\);\n  color: var\(--text\);\n  background: var\(--surface-raised\);\n  box-shadow: var\(--shadow-float\);/mu);
    expect(css).not.toMatch(/\.provider-quota-notice\.is-5 \{|\.database-recovery-notice\.is-critical \{/u);
    expect(css).toMatch(/\.error-toast \{\n  display: flex;\n  min-height: 48px;/u);
    expect(css).not.toMatch(/\.status-overlay-stack > \.error-toast|transform: translateY\(5px\)|grid-template-columns: 17px minmax\(0, 1fr\) 28px|grid-template-columns: 19px/u);
    expect(css).toMatch(/\.renderer-startup-error > h1 \{[^}]*font-weight: 600;/u);
  });
});

describe("icon primitives", () => {
  function tsxSources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return tsxSources(path);
      return /\.tsx?$/u.test(entry.name) ? [path] : [];
    });
  }
  const files = tsxSources("src/renderer/src").map((path) => ({ path, source: readSourceText(path) }));
  const lucideImports = files.map(({ path, source }) => ({
    path,
    source,
    names: (/import \{(?<names>[^}]*)\} from "lucide-react";/u.exec(source)?.groups?.names ?? "")
      .split(",").map((name) => name.trim()).filter(Boolean),
  }));

  it("uses one glyph per action and no generic AI glyphs", () => {
    const retired = new Set([
      "AlertCircle", "AlertTriangle", "CheckCircle2", "Clock3", "Edit3", "FolderSearch", "Folders", "Globe2",
      "LifeBuoy", "LockKeyhole", "PlugZap", "SquareArrowOutUpRight", "Clipboard", "BarChart3", "Bot", "Brain",
      "BrainCircuit", "Command", "Network", "Share2", "WandSparkles", "Table2", "WrapText", "Compass",
      "MessageSquareX", "ArrowUpRight", "LoaderCircle", "Activity", "FilePenLine", "FileSearch",
      "TerminalSquare", "SquareTerminal",
    ]);
    const offenders = lucideImports.flatMap(({ path, names }) => names
      .filter((name) => (retired.has(name) && !(name === "Brain" && path.replaceAll("\\", "/").endsWith("response-timeline/activity.tsx")))
        || (name === "Sparkles" && !path.endsWith("ProjectIcon.tsx")))
      .map((name) => `${path}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it("draws lucide glyphs at 14px or 16px with the shared stroke", () => {
    const offSize: string[] = [];
    for (const { path, source, names } of lucideImports) {
      if (path.endsWith("WelcomeDemos.tsx") || names.length === 0) continue;
      const tags = new RegExp(String.raw`<(?:${names.join("|")})\b[^<>]*?size=\{(\d+)\}`, "gsu");
      for (const match of source.matchAll(tags)) {
        if (!["14", "16"].includes(match[1]!)) offSize.push(`${path}: ${match[0].slice(0, 60)}`);
      }
      const stroked = new RegExp(String.raw`<(?:${names.join("|")})\b[^<>]*?strokeWidth=`, "su");
      if (stroked.test(source)) offSize.push(`${path}: strokeWidth`);
    }
    expect(offSize).toEqual([]);
    expect(css).toMatch(/svg\.lucide \{\n  stroke-width: 1\.75;\n\}/u);
  });
});
