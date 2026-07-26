import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard, InputRequestCard } from "../../src/renderer/src/components/AgentRequestCard";
import {
  agentRequestProviderName,
  buildAgentInputAnswers,
  inputRequestTitle,
} from "../../src/renderer/src/utils/agentInput";
import type { AgentApprovalRequest, AgentInputRequest } from "../../src/shared/contracts";

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
      networkScope: null,
      permissionRoots: [],
      availableDecisions: ["cancel", "deny", "approve"],
    };
    const html = renderToStaticMarkup(createElement(ApprovalCard, {
      request: approval,
      onRespond: vi.fn(),
    }));

    expect(html).toContain('class="agent-request-card is-approval"');
    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-labelledby="approval-${approval.id}"`);
    expect(html).toContain('data-agent-request-kind="command"');
    expect(html).toContain("Cursor paused for your review.");
    expect(html).toContain("npm test -- agent-request-card");
    expect(html).toContain(">Cancel turn</button>");
    expect(html).toContain(">Deny</button>");
    expect(html).toContain(">Approve once</button>");
    expect(html).toContain('aria-hidden="true"');
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
    expect(html).toContain("<fieldset");
    expect(html).toContain('type="radio"');
    expect(html).toContain(`name="${input.id}-strategy"`);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('aria-label="Enter the secret token"');
    expect(html).toContain('aria-label="Submit answers and continue"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="text"');
  });
});
