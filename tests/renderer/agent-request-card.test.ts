import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { declarationsFor, parseCssRules, readRendererCss } from "./css-rules";

import { ApprovalCard, InputRequestCard } from "../../src/renderer/src/components/AgentRequestCard";
import {
  agentRequestProviderName,
  buildAgentInputAnswers,
  inputRequestTitle,
} from "../../src/renderer/src/utils/agentInput";
import type {
  AgentApprovalRequest,
  AgentInputRequest,
} from "../../src/shared/contracts";

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
    expect(html).toContain(`<p id="approval-${approval.id}-description" class="agent-request-detail">Run the focused renderer test.</p>`);
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-agent-request-kind="command"');
    expect(html).toContain('data-agent-request-state="approval"');
    expect(html).not.toContain("Approval required");
    expect(html).not.toContain("paused for your review");
    expect(html).not.toContain("agent-request-kicker");
    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-shield-alert[^"]*agent-request-icon"/u);
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
    expect(html).not.toContain("will continue after every question is answered");
    expect(html).not.toContain("Input required");
    expect(html).not.toContain("aria-describedby");
    expect(html).toMatch(/<legend><span class="agent-input-question-header">[^<]+<\/span>Choose a strategy<\/legend>/u);
    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-message-circle-question[^"]*agent-request-icon"/u);
    expect(html).toMatch(/aria-label="Previous question"[^>]*><svg[^>]*lucide-chevron-left/u);
    expect(html).toContain('data-agent-request-kind="input"');
    expect(html).toContain('data-agent-request-state="question"');
    expect(html).toContain(`id="agent-input-request-${input.id}"`);
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain("<fieldset");
    expect(html).toContain('type="radio"');
    expect(html).toContain(`name="${input.id}-strategy"`);
    expect(html).toContain('aria-label="Question navigation"');
    expect(html).toContain(">Next</button>");
    expect(html).not.toContain("→");
    expect(html).not.toContain("←");
    expect(html).toContain('aria-label="Go to question 2"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('aria-live="polite"');
  });

  it("draws request cards as one raised surface without stripes, kickers or tinted controls", () => {
    const rules = parseCssRules(readRendererCss("styles.css", "components/BeautifulUiMotion.css"));
    const card = declarationsFor(rules, ".agent-request-card");
    expect(card.get("border")).toBe("1px solid var(--line)");
    expect(card.get("background")).toBe("var(--surface-raised)");
    expect(card.has("border-inline-start")).toBe(false);
    expect(declarationsFor(rules, ".agent-request-icon").get("color")).toBe("var(--text-muted)");
    expect(declarationsFor(rules, ".agent-request-heading strong").get("font-weight")).toBe("500");
    const command = declarationsFor(rules, ".agent-request-command");
    expect(command.get("background")).toBe("var(--fill)");
    expect(command.has("border")).toBe(false);
    const option = declarationsFor(rules, ".agent-input-options label");
    expect(option.get("background")).toBe("transparent");
    expect(declarationsFor(rules, ".agent-input-options label:has(input:checked)").get("background"))
      .toBe("var(--fill-strong)");
    expect(declarationsFor(rules, ".agent-input-options input::before").get("background")).toBe("var(--text)");
    expect(declarationsFor(rules, ".agent-input-question:disabled").get("opacity")).toBe("var(--disabled-opacity)");
    const questionHeader = declarationsFor(rules, ".agent-input-question-header");
    expect(questionHeader.get("font-size")).toBe("var(--text-base)");
    expect(questionHeader.get("font-weight")).toBe("500");
    expect(questionHeader.get("color")).toBe("var(--text)");
    expect(questionHeader.has("text-transform")).toBe(false);
    expect(questionHeader.has("letter-spacing")).toBe(false);
    expect(declarationsFor(rules, ".agent-input-page-dots > button[data-answered=\"true\"]").get("background"))
      .toBe("var(--text-muted)");
    const css = readRendererCss("styles.css", "components/BeautifulUiMotion.css");
    expect(css).not.toMatch(/\.agent-[\w-]+[^{}]*\{[^}]*var\(--(?:status-input|status-approval|accent-strong)\)/u);
  });

  it("keeps the pending-input notice quiet with a plain secondary action", () => {
    const rules = parseCssRules(readRendererCss("styles.css"));
    const notice = declarationsFor(rules, ".pending-input-notice");
    expect(notice.get("color")).toBe("var(--text-muted)");
    expect(notice.get("border")).toBe("1px solid var(--line)");
    const action = declarationsFor(rules, ".pending-input-notice button");
    expect(action.get("font-weight")).toBe("500");
    expect(action.get("border")).toBe("1px solid var(--line)");
    expect(action.get("background")).toBe("transparent");
    expect(declarationsFor(rules, ".pending-input-notice button:active").get("background")).toBe("var(--fill-strong)");
  });
});
