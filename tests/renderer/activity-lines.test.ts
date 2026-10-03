import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity } from "../../src/shared/contracts";

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
});
