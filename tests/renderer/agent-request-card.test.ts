import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard, InputRequestCard } from "../../src/renderer/src/components/AgentRequestCard";
import {
  agentRequestProviderName,
  buildAgentInputAnswers,
  inputRequestTitle,
} from "../../src/renderer/src/utils/agentInput";
import { buildTurnExecutionStream } from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
} from "../../src/shared/contracts";

const requestCardSource = readFileSync(
  new URL("../../src/renderer/src/components/AgentRequestCard.tsx", import.meta.url),
  "utf8",
);
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);
const layersSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/layers.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

function cssBlock(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `${selector} should exist`).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("agent input answers", () => {
  const request = {
    id: "11111111-1111-4111-8111-111111111111",
    providerId: "claude",
    conversationId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    autoResolutionMs: null,
  } satisfies Omit<AgentInputRequest, "questions">;

  it("preserves exact secret and custom values while retaining multiple native option IDs", () => {
    const input: AgentInputRequest = {
      ...request,
      questions: [
        { id: "token", header: "Token", question: "Enter the token", isOther: false, isSecret: true, allowMultiple: false, options: [] },
        {
          id: "targets",
          header: "Targets",
          question: "Choose targets",
          isOther: true,
          isSecret: false,
          allowMultiple: true,
          options: [
            { id: "native-api", label: "API", description: "" },
            { id: "native-web", label: "Web", description: "" },
          ],
        },
      ],
    };

    expect(buildAgentInputAnswers(input, {
      token: "  secret value  ",
      targets: ["native-api", "native-web", "a custom target"],
    })).toEqual({
      token: ["  secret value  "],
      targets: ["native-api", "native-web", "a custom target"],
    });
  });

  it("uses the emitting provider captured on the request for branding", () => {
    expect(agentRequestProviderName("claude")).toBe("Claude");
    expect(inputRequestTitle("claude")).toBe("Claude needs your input");
    expect(inputRequestTitle("cursor")).toBe("Cursor needs your input");
    expect(inputRequestTitle("kimi")).toBe("Kimi Code needs your input");
    expect(inputRequestTitle("opencode")).toBe("OpenCode needs your input");
    expect(inputRequestTitle("codex")).toBe("Codex needs your input");
    expect(inputRequestTitle("future-provider")).toBe("The agent needs your input");
  });

  it("renders a compact approval region with captured provider identity and labelled actions", () => {
    const approval: AgentApprovalRequest = {
      id: "55555555-5555-4555-8555-555555555555",
      providerId: "cursor",
      conversationId: request.conversationId,
      runId: request.runId,
      turnId: request.turnId,
      kind: "command",
      title: "Approve command",
      detail: "Run the focused renderer test.",
      command: "npm test -- agent-request-card",
      cwd: "/workspace/inertia",
      reason: "Verify the interaction.",
      networkScope: { protocol: "https", host: "api.example.test" },
      permissionRoots: [
        { access: "read", path: "/workspace/inertia/src" },
        { access: "write", path: "/workspace/inertia/tests" },
      ],
      availableDecisions: ["cancel", "deny", "approve"],
    };
    const html = renderToStaticMarkup(createElement(ApprovalCard, {
      request: approval,
      onRespond: vi.fn(),
    }));

    expect(html).toContain('class="agent-request-card is-approval"');
    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-labelledby="approval-${approval.id}"`);
    expect(html).toContain(`aria-describedby="approval-${approval.id}-description"`);
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-agent-request-kind="command"');
    expect(html).toContain('data-agent-request-state="approval"');
    expect(html).toContain("Approval required");
    expect(html).toContain("Cursor paused for your review.");
    expect(html).toContain("npm test -- agent-request-card");
    expect(html).toContain('aria-label="Command awaiting approval"');
    expect(html).toContain("Run the focused renderer test.");
    expect(html).toContain("Verify the interaction.");
    expect(html).toContain("/workspace/inertia");
    expect(html).toContain("HTTPS · api.example.test");
    expect(html).toContain("read: /workspace/inertia/src");
    expect(html).toContain("write: /workspace/inertia/tests");
    expect(html).toContain('data-agent-request-decision="cancel"');
    expect(html).toContain('data-agent-request-decision="deny"');
    expect(html).toContain('data-agent-request-decision="approve"');
    expect(html).toContain(">Cancel turn</button>");
    expect(html).toContain(">Deny</button>");
    expect(html).toContain(">Approve once</button>");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-live="polite"');
  });

  it("keeps question groups keyboard-native and secret answers masked and labelled", () => {
    const input: AgentInputRequest = {
      ...request,
      providerId: "opencode",
      questions: [
        {
          id: "strategy",
          header: "Strategy",
          question: "Choose a strategy",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [
            { id: "focused", label: "Focused", description: "Change only the card." },
            { id: "broad", label: "Broad", description: "Change the timeline too." },
          ],
        },
        {
          id: "token",
          header: "Token",
          question: "Enter the secret token",
          isOther: false,
          isSecret: true,
          allowMultiple: false,
          options: [],
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(InputRequestCard, {
      request: input,
      onRespond: vi.fn(),
    }));

    expect(html).toContain("OpenCode needs your input");
    expect(html).toContain("OpenCode will continue after every question is answered.");
    expect(html).toContain("Input required");
    expect(html).toContain(`aria-describedby="input-${input.id}-description"`);
    expect(html).toContain('data-agent-request-kind="input"');
    expect(html).toContain('data-agent-request-state="question"');
    expect(html).toContain(`id="agent-input-request-${input.id}"`);
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain("<fieldset");
    expect(html).toContain('type="radio"');
    expect(html).toContain(`name="${input.id}-strategy"`);
    expect(requestCardSource).toContain('type={question.isSecret ? "password" : "text"}');
    expect(requestCardSource).toContain('autoComplete="off"');
    expect(requestCardSource).toContain('autoCapitalize={question.isSecret ? "none" : undefined}');
    expect(requestCardSource).toContain('spellCheck={question.isSecret ? false : undefined}');
    expect(requestCardSource).toContain("aria-label={question.question}");
    expect(html).toContain('aria-label="Question navigation"');
    expect(html).toContain("Next →");
    expect(html).toContain('aria-label="Go to question 2"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('aria-live="polite"');
  });

  it("keeps submission guards and busy disabling at the interactive boundary", () => {
    expect(requestCardSource).toContain("if (busy) return;");
    expect(requestCardSource).toContain("if (!complete || busy) return;");
    expect(requestCardSource).toContain('disabled={busy}');
    expect(requestCardSource).toContain('disabled={busy || (lastQuestion ? !complete : !activeQuestionComplete)}');
    expect(requestCardSource).toContain('type={question.allowMultiple ? "checkbox" : "radio"}');
    expect(requestCardSource).toContain('type={question.isSecret ? "password" : "text"}');
    expect(requestCardSource).toContain('aria-busy={busy}');
  });

  it("uses a restrained semantic treatment across themes, scales, and narrow cards", () => {
    const card = cssBlock(".agent-request-card");
    const question = cssBlock(".agent-request-card.is-question");
    const icon = cssBlock(".agent-request-icon");
    const alignment = cssBlock(".agent-run-flow > .agent-request-card");

    expect(card).toContain("--agent-request-accent: var(--approval-accent)");
    expect(card).toContain("padding: 8px 10px");
    expect(card).toContain("border-inline-start: 2px solid var(--agent-request-accent)");
    expect(card).toContain("--agent-request-surface: var(--approval-surface)");
    expect(card).toContain("background: var(--agent-request-surface)");
    expect(question).toContain(
      "--agent-request-surface: var(--question-surface)",
    );
    expect(card).toContain("box-shadow: none");
    expect(card).not.toContain("3px solid");
    expect(question).toContain("--agent-request-accent: var(--question-accent)");
    expect(icon).toContain("color: var(--agent-request-accent)");
    expect(icon).toContain("background: transparent");
    expect(alignment).toContain("max-width: var(--answer-max-width)");

    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain(':root[data-interface-scale="compact"]');
    expect(styles).toContain(':root[data-interface-scale="large"]');
    expect(styles).toContain("@container (max-width: 420px)");
    expect(styles).toContain(".agent-input-options label:has(input:focus-visible)");
    expect(styles).toContain(".agent-input-text:focus-visible");
    expect(styles).toContain("min-height: max(30px, var(--control-height-small))");
  });

  it("keeps approvals and questions outside activity grouping and in stable response order", () => {
    const activity: AgentActivity = {
      id: "66666666-6666-4666-8666-666666666666",
      conversationId: request.conversationId,
      runId: request.runId,
      turnId: request.turnId,
      kind: "command",
      title: "Ran the test",
      detail: null,
      status: "completed",
      createdAt: "2026-07-27T08:00:00.000Z",
    };
    const stream = buildTurnExecutionStream({
      id: request.turnId,
      agentTurn: { updatedAt: activity.createdAt } as AgentTurn,
      followUpMessages: [],
      commentaryMessages: [],
      activities: [activity],
      approvals: [{ id: "approval-not-a-stream-row" }],
      inputRequests: [{ id: "question-not-a-stream-row" }],
    } as Parameters<typeof buildTurnExecutionStream>[0] & {
      approvals: Array<{ id: string }>;
      inputRequests: Array<{ id: string }>;
    });

    expect(stream).toHaveLength(1);
    expect(stream[0]).toMatchObject({
      kind: "activity-group",
      activities: [{ id: activity.id }],
    });

    const executionStreamSource = activitySource.slice(
      activitySource.indexOf("function ExecutionStream"),
      activitySource.indexOf("export function WorkLog"),
    );
    const approvalsIndex = layersSource.indexOf("{turn.approvals.map");
    const questionsIndex = layersSource.indexOf("{turn.inputRequests.map");
    expect(executionStreamSource).not.toContain("ApprovalCard");
    expect(executionStreamSource).not.toContain("InputRequestCard");
    expect(approvalsIndex).toBeGreaterThan(layersSource.indexOf("<WorkLog"));
    expect(questionsIndex).toBeGreaterThan(approvalsIndex);
  });
});
