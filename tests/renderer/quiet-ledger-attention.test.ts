import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import {
  activityAttentionSeverity,
  activityNeedsAttention,
  isInterruptedActivity,
} from "../../src/renderer/src/utils/responseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

const baseStyles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);
const groupStyles = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/ActivityGroup.css", import.meta.url),
  "utf8",
);
const styles = [baseStyles, groupStyles].join("\n");
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "attention-activity",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind: "command",
    title: "Completed command",
    detail: null,
    status: "completed",
    createdAt: "2026-07-27T09:00:00.000Z",
    ...overrides,
  };
}

function cssBlock(marker: string): string {
  const markerIndex = styles.indexOf(marker);
  expect(markerIndex, `${marker} should exist`).toBeGreaterThanOrEqual(0);
  const openIndex = styles.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openIndex; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block for ${marker}`);
}

describe("Quiet Ledger warning and failure attention", () => {
  it("classifies failed/error activity and warning, cancelled, blocked, and partial outcomes", () => {
    const cases: Array<[Partial<AgentActivity>, "warning" | "failure" | null]> = [
      [{ status: "failed", title: "Command stopped" }, "failure"],
      [{ status: "failed", title: "Interrupted · npm test" }, "warning"],
      [{ kind: "error", title: "Provider could not continue" }, "failure"],
      [{ title: "Warning: fallback used" }, "warning"],
      [{ title: "Command cancelled by the user" }, "warning"],
      [{ title: "Upload blocked by policy" }, "warning"],
      [{ title: "Partial provider result" }, "warning"],
      [{ title: "Response incomplete" }, "warning"],
      [{ title: "Completed command" }, null],
    ];

    for (const [overrides, expected] of cases) {
      const item = activity(overrides);
      expect(activityAttentionSeverity(item)).toBe(expected);
      expect(activityNeedsAttention(item)).toBe(expected !== null);
    }
    expect(isInterruptedActivity(activity({
      status: "failed",
      title: "Interrupted · npm test",
    }))).toBe(true);
    expect(isInterruptedActivity(activity({
      status: "failed",
      title: "Tests failed",
      detail: "A test assertion failed.",
    }))).toBe(false);
  });

  it("uses visible text plus color without repeating an existing severity headline", () => {
    const implicitFailure = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        status: "failed",
        title: "Provider could not complete the request",
        detail: "Process exited with status 1.\nRetry after checking provider configuration.",
      }),
      visibility: "important",
    }));
    const explicitFailure = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        status: "failed",
        title: "Tests failed",
      }),
      visibility: "important",
    }));

    expect(implicitFailure).toContain('data-activity-severity="failure"');
    expect(implicitFailure).toContain('class="agent-activity is-failed is-important has-technical-detail"');
    expect(implicitFailure).toContain('<span class="visually-hidden">Failed: </span>');
    expect(implicitFailure).toContain('<span class="agent-activity-state" aria-hidden="true">Failed</span>');
    expect(implicitFailure).toContain("lucide-triangle-alert");
    expect(implicitFailure).toContain(
      'title="Provider could not complete the request"',
    );
    expect(implicitFailure).toContain("<span>Output</span>");
    expect(implicitFailure).not.toContain("Process exited with status 1.");
    expect(explicitFailure).not.toContain('class="agent-activity-state"');
    expect(explicitFailure).toContain('<span class="visually-hidden">Failed: </span>');
  });

  it("renders transport diagnostics as technical details and interrupted calls as warnings", () => {
    const interrupted = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        status: "failed",
        title: "Interrupted · npm test",
        detail: "Interrupted: The Codex App Server connection closed.",
      }),
      visibility: "important",
    }));
    const terminal = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        kind: "error",
        status: "failed",
        title: "The Codex App Server connection closed.",
        detail: "Reason: transport-closed\nExit code: none\nSignal: none",
      }),
      visibility: "important",
    }));

    expect(interrupted).toContain('data-activity-severity="warning"');
    expect(interrupted).toContain('<span class="visually-hidden">Interrupted: </span>');
    expect(interrupted).not.toContain('class="agent-activity-state"');
    expect(interrupted).toContain("<span>Details</span>");
    expect(interrupted).toContain('title="Interrupted · npm test"');
    expect(interrupted).not.toContain("The Codex App Server connection closed.");
    expect(terminal).toContain("<span>Details</span>");
    expect(terminal).not.toContain("Reason: transport-closed");
    expect(terminal).not.toContain("system_prompt");
  });

  it("keeps technical information behind a compact disclosure button and neutral detail inline", () => {
    const warning = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        kind: "status",
        title: "Fallback activated",
        detail: "An unsupported optional capability was skipped.",
      }),
      visibility: "important",
    }));
    const neutral = renderToStaticMarkup(createElement(ActivityRow, {
      activity: activity({
        kind: "status",
        title: "Verified renderer",
        detail: "npm test -- renderer",
      }),
    }));

    expect(warning).toContain('data-activity-severity="warning"');
    expect(warning).toContain('<span class="agent-activity-state" aria-hidden="true">Warning</span>');
    expect(warning).toContain('class="agent-activity-disclosure"');
    expect(warning).toContain('aria-label="Output: Fallback activated"');
    expect(warning).not.toContain("<pre");
    expect(warning).not.toContain('role="alert"');
    expect(warning).not.toContain('aria-live="assertive"');
    expect(activitySource).toContain("{...anchorToggleHandlers}");
    expect(activitySource).toContain("anchorToggleHandlers.onClick();");
    expect(activitySource).toContain("onBeforeToggle={onBeforeToggle}");
    expect(activitySource).toContain("onAfterToggle={onAfterToggle}");

    expect(neutral).toContain('data-activity-severity="neutral"');
    expect(neutral).toContain('<small class="agent-activity-detail">');
    expect(neutral).not.toContain("agent-activity-disclosure");
  });

  it("stays compact and transparent across semantic themes, scales, and narrow layouts", () => {
    const row = cssBlock(".turn-activity-group .agent-activity {");
    const disclosure = cssBlock(".turn-activity-group .agent-activity-disclosure {");
    const technical = cssBlock(".turn-activity-group .agent-activity-output {");
    const narrow = cssBlock("@container response-transcript (max-width: 440px) {\n  .turn-activity-group-rows");

    expect(row).toContain("min-height: 24px");
    expect(row).toContain("background: transparent");
    expect(row).toContain("border: 0");
    expect(row).not.toContain("box-shadow");
    expect(disclosure).toContain("min-height: 20px");
    expect(disclosure).toContain("font-size: var(--ui-font-micro)");
    expect(technical).toContain("max-height: 160px");
    expect(technical).toContain("border: 0");
    expect(technical).toContain("background: transparent");
    expect(styles).toContain(".turn-activity-group .agent-activity-disclosure:focus-visible");
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(':root[data-interface-scale="compact"]');
    expect(styles).toContain(':root[data-interface-scale="large"]');
    expect(narrow).toContain(".turn-activity-group .agent-activity-output");
    expect(narrow).toContain("max-height: 120px");
  });
});
