import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
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
  it("renders a semantic compact line with a bounded command preview and intentional disclosure", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity(),
      visibility: "recent",
    }));

    expect(html).toContain('data-activity-kind="command"');
    expect(html).toContain('data-activity-severity="neutral"');
    expect(html).toContain('data-activity-visibility="recent"');
    expect(html).toContain(
      'title="Running focused renderer verification — npm test -- activity-lines"',
    );
    expect(html).toContain(
      '<span class="agent-activity-verb">Running</span>',
    );
    expect(html).toContain(
      '<span class="agent-activity-target"> focused renderer verification</span>',
    );
    expect(html).toContain(
      '<small class="agent-activity-detail-preview"><span class="visually-hidden">Technical output preview: </span>npm test -- activity-lines</small>',
    );
    expect(html).toContain("<details");
    expect(html).toContain("Full command output");
    expect(html).not.toContain("<pre>");
    expect(html).toContain("Working:");
    expect(html).toContain("lucide-circle-dot");
  });

  it("limits huge output to three preview lines without mounting closed full detail", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        detail: [
          "Command:",
          "npm test",
          "Output:",
          "first result",
          "second result",
          "third result",
        ].join("\n"),
        status: "failed",
      }),
    }));

    expect(html).toContain("Command:\nnpm test\nOutput:");
    expect(html).not.toContain(
      '<small class="agent-activity-detail-preview"><span class="visually-hidden">Technical output preview: </span>Command:\nnpm test\nOutput:\nfirst result',
    );
    expect(html).not.toContain("first result");
    expect(html).not.toContain("third result");
    expect(html).toContain("Full command output");
    expect(html).toContain("Technical output preview:");
    expect(html).not.toContain("<pre>");
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
    expect(completed).toContain("lucide-check");
    expect(warning).toContain('data-activity-severity="warning"');
    expect(warning).toContain("Warning:");
    expect(warning).toContain("lucide-triangle-alert");
    expect(warning).toContain(
      '<span class="agent-activity-target">Unsupported option </span><span class="agent-activity-verb">skipped</span>',
    );
    expect(warning).not.toContain("lucide-check");
    expect(error).toContain('data-activity-severity="failure"');
    expect(error).toContain("Failed:");
    expect(error).toContain("lucide-triangle-alert");
    expect(error).toContain(
      '<span class="agent-activity-target">Provider response </span><span class="agent-activity-verb">failed</span>',
    );
    expect(error).not.toContain("lucide-check");
  });

  it("uses an extremely compact, rail-aligned line with safe title and detail truncation", () => {
    const row = cssBlock(css, ".turn-work-log .agent-activity {");
    const rail = cssBlock(css, ".turn-activity-group {");
    const title = cssBlock(css, ".turn-work-log .agent-activity-title {");
    const targetAndDetail = cssBlock(
      css,
      ".turn-work-log .agent-activity-target,",
    );

    expect(row).toContain("min-height: 20px");
    expect(row).toContain("padding: 0");
    expect(row).toContain("background: transparent");
    expect(row).toContain("font-size: var(--activity-row-font-size)");
    expect(rail).toContain(
      "border-left: 1px solid color-mix(in srgb, var(--execution-rail-border) 62%, transparent)",
    );
    expect(title).toContain("min-width: 0");
    expect(title).toContain("gap: 4px");
    expect(title).toContain("overflow: hidden");
    expect(targetAndDetail).toContain("text-overflow: ellipsis");
    expect(targetAndDetail).toContain("white-space: nowrap");
  });

  it("uses semantic warning/failure lines without card backgrounds or large alert rows", () => {
    const important = cssBlock(
      css,
      ".turn-work-log .agent-activity.is-important,",
    );
    const warning = cssBlock(
      css,
      '.turn-work-log .agent-activity[data-activity-severity="warning"] > svg,',
    );
    const failure = cssBlock(
      css,
      '.turn-work-log .agent-activity[data-activity-severity="failure"] > svg,',
    );
    const completed = cssBlock(
      css,
      ".turn-work-log .agent-activity.is-completed > svg",
    );

    expect(important).toContain("border: 0");
    expect(important).toContain("border-radius: 0");
    expect(important).toContain("background: transparent");
    expect(important).not.toMatch(/padding:\s*[4-9]px|box-shadow/iu);
    expect(warning).toContain("color: var(--warning-accent)");
    expect(failure).toContain("color: var(--failure-accent)");
    expect(completed).toContain("var(--success-accent)");
    expect(completed).toContain("var(--execution-muted-text)");
    expect(completed).toContain("animation: none");
  });

  it("preserves adjacent grouping, expandable history, reduced motion, and command review details", () => {
    const reducedMotion = css.slice(
      css.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(activitySource).toContain(
      '<div className="turn-execution-stream" role="list" aria-label="Agent work transcript">',
    );
    expect(activitySource).toContain('className="turn-activity-group"');
    expect(activitySource).toContain("data-activity-group={entry.id}");
    expect(activitySource).toContain("aria-expanded={expanded}");
    expect(activitySource).toContain("previous tool");
    expect(reducedMotion).toContain(
      ".turn-work-log .agent-activity.is-running svg",
    );
    expect(reducedMotion).toContain("animation: none");
    expect(requestCardSource).toContain('className="agent-request-command"');
    expect(requestCardSource).toContain(
      'request.detail && <p className="agent-request-detail">{request.detail}</p>',
    );
    expect(requestCardSource).toContain(
      "request.cwd && <><dt>Location</dt><dd>{request.cwd}</dd></>",
    );
  });
});
