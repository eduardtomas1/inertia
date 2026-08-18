import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PlanPanel } from "../../src/renderer/src/components/PlanPanel";

const changesSource = readFileSync(new URL("../../src/renderer/src/components/ChangesPanel.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../../src/renderer/src/components/composer/ComposerInputZone.tsx", import.meta.url), "utf8");
const commandMenuSource = readFileSync(new URL("../../src/renderer/src/components/composer/ComposerCommandMenu.tsx", import.meta.url), "utf8");
const responseSource = readFileSync(new URL("../../src/renderer/src/components/ResponseMarkdown.tsx", import.meta.url), "utf8");
const layersSource = readFileSync(new URL("../../src/renderer/src/components/response-timeline/layers.tsx", import.meta.url), "utf8");
const styles = [
  readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8"),
  readFileSync(new URL("../../src/renderer/src/components/BeautifulUiMotion.css", import.meta.url), "utf8"),
].join("\n");
const usageStyles = readFileSync(new URL("../../src/renderer/src/components/UsageView.css", import.meta.url), "utf8");

describe("Beautiful UI primitive adaptations", () => {
  it("renders plan steps as truthful connected task states", () => {
    const html = renderToStaticMarkup(
      createElement(PlanPanel, {
        steps: [
          {
            id: "inspect",
            title: "Inspect provider state",
            status: "completed",
          },
          {
            id: "build",
            title: "Build the interaction",
            status: "in-progress",
          },
          { id: "verify", title: "Verify the result", status: "pending" },
        ],
        activeStepId: "build",
        onSelectStep: vi.fn(),
      }),
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('data-plan-step-status="completed"');
    expect(html).toContain('data-plan-step-status="in-progress"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("In progress");
    expect(styles).toContain(".plan-step:not(:last-child)::after");
    expect(styles).toContain("animation: beautiful-fade-up 450ms");
    expect(styles).toContain("animation: beautiful-spin 1.1s linear infinite");
    expect(styles).toContain(".plan-step.is-in-progress .plan-step-marker svg");
  });

  it("uses counted filter chips instead of a passive review-state select", () => {
    expect(changesSource).toContain('className="diff-review-filter"');
    expect(changesSource).toContain('role="group"');
    expect(changesSource).toContain('aria-label="Filter review state"');
    expect(changesSource).toContain("aria-pressed={reviewFilter === value}");
    expect(changesSource).toContain('["unreviewed", totalHunks - reviewedHunks]');
    expect(changesSource).not.toContain('<select aria-label="Filter review state"');
    expect(changesSource).toContain('className="diff-filter-row"');
    expect(changesSource).toContain("inert={!shown}");
    expect(styles).toContain("grid-template-rows 300ms cubic-bezier(0.23, 1, 0.32, 1)");
  });

  it("animates project references and slash commands as prompt actions", () => {
    expect(composerSource).toContain('aria-label="Project files"');
    expect(commandMenuSource).toContain('aria-label="Composer commands"');
    expect(styles).toContain("animation: beautiful-pop-in 180ms cubic-bezier(0.23, 1, 0.32, 1)");
  });

  it("ports the Beautiful UI motion constants onto real Inertia state", () => {
    expect(layersSource).toContain("Array.from({ length: 9 }");
    expect(styles).toContain("--pixel-drive-delay: 90ms");
    expect(styles).toContain("--pixel-orbit-delay: 770ms");
    expect(styles).toContain("animation: agent-pixel-shimmer 650ms ease-in-out infinite");
    expect(styles).toContain("animation-duration: 950ms");
    expect(styles).toContain("animation: beautiful-shimmer-text 1.4s linear infinite");

    expect(responseSource).toContain('className="response-stream-word"');
    expect(styles).toContain("beautiful-stream-in 420ms cubic-bezier(0.22, 0.61, 0.25, 1)");
    expect(styles).toContain(".response-markdown.is-streaming a { animation: beautiful-pop-in 250ms cubic-bezier(0.23, 1, 0.32, 1)");

    expect(styles).toContain("reasoning-step-enter 320ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(styles).toContain("var(--motion-index, 0) * 120ms");
    expect(styles).toContain("beautiful-spin 700ms linear infinite");
    expect(styles).toContain("beautiful-fade-up 350ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(styles).toContain("var(--motion-index, 0) * 80ms");
    expect(styles).toContain("var(--motion-index, 0) * 100ms");
    expect(styles).toContain("700ms + var(--motion-index, 0) * 80ms");

    expect(usageStyles).toContain("width 500ms cubic-bezier(0.23, 1, 0.32, 1)");
    expect(usageStyles).toContain("usage-insight-content-in 250ms ease both");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
