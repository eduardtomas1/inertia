import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

const motionCss = readFileSync(
  new URL("../../src/renderer/src/components/BeautifulUiMotion.css", import.meta.url),
  "utf8",
);
const baseCss = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const groupCss = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/ActivityGroup.css", import.meta.url),
  "utf8",
);
const css = [motionCss, baseCss, groupCss].join("\n");
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);
const requestCardSource = readFileSync(
  new URL("../../src/renderer/src/components/AgentRequestCard.tsx", import.meta.url),
  "utf8",
);

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "activity-1",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind: "command",
    title: "Running focused renderer verification",
    detail: "npm test -- activity-lines",
    status: "running",
    createdAt: "2026-07-27T08:00:00.000Z",
    ...overrides,
  };
}

function cssBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return "";
  const openIndex = source.indexOf("{", markerIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return "";
}

describe("Minimal Workstream activity lines", () => {
  it("renders a semantic one-line row with an intentional output disclosure and no inline preview", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity(),
      visibility: "recent",
    }));

    expect(html).toContain('data-activity-kind="command"');
    expect(html).toContain('data-activity-severity="neutral"');
    expect(html).toContain('data-activity-visibility="recent"');
    expect(html).toContain('data-activity-work="command"');
    expect(html).toContain('title="Running focused renderer verification"');
    expect(html).toContain(
      '<span class="agent-activity-verb">Running</span>',
    );
    expect(html).toContain(
      '<span class="agent-activity-target"> focused renderer verification</span>',
    );
    expect(html).not.toContain("agent-activity-detail-preview");
    expect(html).not.toContain("npm test -- activity-lines");
    expect(html).toContain('class="agent-activity-disclosure"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Output: Running focused renderer verification"');
    expect(html).not.toContain("<pre");
    expect(html).toContain("Working:");
    expect(html).toContain('data-activity-category="command"');
    expect(html).toContain('<span class="agent-activity-icon" aria-hidden="true">');
    expect(html).toContain("lucide-terminal");
  });

  it("names generic provider commands by the unwrapped command and never mounts closed output", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        title: "Command",
        detail: [
          "Command:",
          "/bin/bash -lc 'cd /workspace && npm test'",
          "",
          "Output:",
          "first result",
          "second result",
        ].join("\n"),
        status: "failed",
      }),
    }));

    expect(html).toContain('title="Ran npm test"');
    expect(html).toContain('<span class="agent-activity-verb">Ran</span>');
    expect(html).toContain('<span class="agent-activity-target is-command"> npm test</span>');
    expect(html).not.toContain("/bin/bash");
    expect(html).not.toContain("first result");
    expect(html).toContain('<span class="agent-activity-state" aria-hidden="true">Failed</span>');
    expect(html).toContain("<span>Output</span>");
    expect(html).not.toContain("<pre");
  });

  it("keeps completed work quiet while warning and error truth override a completed check", () => {
    const completed = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        title: "Verified renderer behavior",
        detail: null,
        status: "completed",
      }),
    }));
    const warning = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        kind: "status",
        title: "Unsupported option skipped",
        detail: "The provider ignored one optional flag.",
        status: "completed",
      }),
    }));
    const error = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        kind: "error",
        title: "Provider response failed",
        detail: "The process exited with status 1.",
        status: "completed",
      }),
    }));

    expect(completed).toContain('data-activity-severity="neutral"');
    expect(completed).toContain("agent-activity is-completed");
    expect(completed).not.toContain("agent-activity is-running");
    expect(completed).toContain("lucide-terminal");
    expect(warning).toContain('data-activity-severity="warning"');
    expect(warning).toContain("Warning:");
    expect(warning).toContain("lucide-triangle-alert");
    expect(warning).toContain(
      '<span class="agent-activity-target">Unsupported option </span><span class="agent-activity-verb">skipped</span>',
    );
    expect(error).toContain('data-activity-severity="failure"');
    expect(error).toContain("Failed:");
    expect(error).toContain("lucide-triangle-alert");
    expect(error).toContain(
      '<span class="agent-activity-target">Provider response </span><span class="agent-activity-verb">failed</span>',
    );
  });

  it("uses a compact single-line grid row with safe title and detail truncation", () => {
    const row = cssBlock(groupCss, ".turn-activity-group .agent-activity {");
    const icon = cssBlock(groupCss, ".turn-activity-group .agent-activity > .agent-activity-icon {");
    const rail = cssBlock(groupCss, ".turn-activity-group-rows {");
    const title = cssBlock(groupCss, ".turn-activity-group .agent-activity-title {");
    const targetAndDetail = cssBlock(
      groupCss,
      ".turn-activity-group .agent-activity-target,",
    );
    const output = cssBlock(groupCss, ".turn-activity-group .agent-activity-output {");

    expect(row).toContain("min-height: 24px");
    expect(row).toContain("grid-template-columns: 16px minmax(0, 1fr) auto auto");
    expect(row).toContain("background: transparent");
    expect(row).toContain("font-size: var(--activity-row-font-size)");
    expect(icon).toContain("width: 16px");
    expect(icon).toContain("place-items: center");
    expect(icon).toContain("box-shadow: none");
    expect(rail).toContain(
      "border-left: 1px solid color-mix(in srgb, var(--execution-rail-border) 62%, transparent)",
    );
    expect(title).toContain("min-width: 0");
    expect(title).toContain("overflow: hidden");
    expect(targetAndDetail).toContain("text-overflow: ellipsis");
    expect(targetAndDetail).toContain("white-space: nowrap");
    expect(cssBlock(groupCss, ".turn-activity-group .agent-activity-target.is-command {"))
      .toContain("font-family: var(--font-mono)");
    expect(output).toContain("max-height: 160px");
    expect(output).toContain("grid-column: 2 / -1");
    expect(css).not.toContain("text-transform: uppercase;\n}\n\n.turn-work-log .agent-activity");
    expect(motionCss).not.toContain(".agent-activity > .agent-activity-copy");
  });

  it("uses semantic warning/failure color without card backgrounds or colored group rails", () => {
    const warning = cssBlock(
      groupCss,
      '.turn-activity-group .agent-activity[data-activity-severity="warning"] > .agent-activity-icon,',
    );
    const failure = cssBlock(
      groupCss,
      '.turn-activity-group .agent-activity[data-activity-severity="failure"] > .agent-activity-icon,',
    );

    expect(warning).toContain("color: var(--warning-accent)");
    expect(failure).toContain("color: var(--failure-accent)");
    expect(css).not.toContain(".turn-activity-group:has(");
    expect(css).not.toMatch(/\.agent-activity[^{]*\{[^}]*box-shadow: 0/u);
  });

  it("folds rows with one height-and-opacity motion, a live window, and reduced-motion fallbacks", () => {
    const row = cssBlock(groupCss, ".turn-activity-group-row {");
    const folded = cssBlock(groupCss, '.turn-activity-group-row[data-folded="true"] {');
    const starting = cssBlock(groupCss, "@starting-style");
    const reduced = cssBlock(groupCss, "@media (prefers-reduced-motion: reduce)");

    expect(activitySource).toContain(
      '<div className="turn-execution-stream" role="list" aria-label="Agent work transcript">',
    );
    expect(activitySource).toContain('className="turn-activity-group"');
    expect(activitySource).toContain("data-activity-group={entry.id}");
    expect(activitySource).toContain("data-activity-group-expanded={expanded}");
    expect(activitySource).toContain("aria-expanded={expanded}");
    expect(activitySource).toContain("inert={rowFolded || undefined}");
    expect(activitySource).toContain('className="agent-activity-icon"');
    expect(row).toContain("grid-template-rows: 1fr");
    expect(row).toContain("grid-template-rows 340ms var(--motion-ease)");
    expect(folded).toContain("grid-template-rows: 0fr");
    expect(folded).toContain("opacity: 0");
    expect(starting).toContain("grid-template-rows: 0fr");
    expect(reduced).toContain(".turn-activity-group-row,");
    expect(reduced).toContain("transition: none");
    expect(reduced).toContain("animation: none");
    expect(css).not.toContain("@keyframes activity-row-reveal");
    expect(css).not.toContain("beautiful-tool-row-enter");
    expect(requestCardSource).toContain('className="agent-request-command"');
    expect(requestCardSource).toContain(
      'request.detail && <p className="agent-request-detail">{request.detail}</p>',
    );
    expect(requestCardSource).toContain(
      '["Location", request.cwd]',
    );
  });
});
