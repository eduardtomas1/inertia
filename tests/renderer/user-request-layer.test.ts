import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentTurn,
  ChatAttachment,
  ChatMessage,
  CheckpointSummary,
} from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestedAt = "2026-07-23T10:00:00.000Z";
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

function turn(checkpointId: string | null = null): AgentTurn {
  return {
    id: "turn-1",
    conversationId,
    runId: "run-1",
    userMessageId: "user-1",
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 3,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 3,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: "session-after",
    requestedAt,
    startedAt: "2026-07-23T10:00:01.000Z",
    completedAt: "2026-07-23T10:00:02.000Z",
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: "2026-07-23T10:00:02.000Z",
  };
}

function message(content: string, attachments: ChatAttachment[] = []): ChatMessage {
  return {
    id: "user-1",
    conversationId,
    turnId: "turn-1",
    role: "user",
    content,
    attachments,
    createdAt: requestedAt,
  };
}

function renderRequest(
  content: string,
  options: {
    attachment?: ChatAttachment;
    checkpoint?: CheckpointSummary;
    checkpointRestoreDisabled?: boolean;
    internalInstruction?: string;
  } = {},
): string {
  const currentTurn = turn(options.checkpoint?.id ?? null);
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: [currentTurn],
    messages: [
      message(content, options.attachment ? [options.attachment] : []),
      ...(options.internalInstruction
        ? [{
            id: "system-1",
            conversationId,
            turnId: "turn-1",
            role: "system" as const,
            content: options.internalInstruction,
            attachments: [],
            createdAt: "2026-07-23T10:00:00.500Z",
          }]
        : []),
    ],
    activities: [],
    reasonings: [],
    plans: [],
    checkpoints: options.checkpoint ? [options.checkpoint] : [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId,
    streamingText: "",
    streamingReasoning: "",
    approvals: [],
    inputRequests: [],
    showTimestamps: true,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: options.checkpointRestoreDisabled ?? false,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop: () => undefined,
  }));
}

describe("Quiet Ledger user request layer", () => {
  it("keeps request metadata and attachments beneath a content-width request", () => {
    const checkpoint: CheckpointSummary = {
      id: "checkpoint-1",
      conversationId,
      turnId: "turn-1",
      ref: "refs/inertia/checkpoints/conversation/checkpoint",
      label: "Before turn 1",
      turnIndex: 1,
      filesChanged: 2,
      insertions: 4,
      deletions: 1,
      createdAt: requestedAt,
    };
    const html = renderRequest("Please inspect this reference.", {
      checkpoint,
      checkpointRestoreDisabled: true,
      attachment: {
        id: "attachment-1",
        name: "reference.png",
        path: "/workspace/reference.png",
        mimeType: "image/png",
        size: 1_024,
      },
    });

    expect(html).toContain('class="message is-user turn-user-request"');
    expect(html).toContain('data-turn-layer="user-request"');
    expect(html).toContain('data-request-layout="content"');
    expect(html).toContain(`<time dateTime="${requestedAt}">`);
    expect(html).toContain('class="message-revert"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Request context"');
    expect(html).toContain('data-request-context-kind="image"');
    expect(html).toContain("PNG image · reference.png");
    expect(html).not.toContain("/workspace/reference.png");
    expect(html.indexOf("PNG image · reference.png"))
      .toBeGreaterThan(html.indexOf("Please inspect this reference."));
  });

  it("labels historical documents truthfully without exposing their private path", () => {
    const html = renderRequest("Review the attached brief.", {
      attachment: {
        id: "attachment-pdf",
        name: "brief.pdf",
        path: "/private/runtime/brief.pdf",
        mimeType: "application/pdf",
        size: 4_096,
      },
    });

    expect(html).toContain('data-request-context-kind="document"');
    expect(html).toContain("PDF document · brief.pdf");
    expect(html).not.toContain("/private/runtime/brief.pdf");
    expect(html).not.toContain("Image · brief.pdf");
  });

  it("uses the wider document treatment only for long persisted request prose", () => {
    const html = renderRequest("Long request. ".repeat(30));

    expect(html).toContain("turn-user-request is-document-like");
    expect(html).toContain('data-request-layout="document"');
    expect(html).not.toContain("turn-user-request-context");
  });

  it("collapses very long requests behind an accessible disclosure", () => {
    const html = renderRequest("Long pasted requirement. ".repeat(100));

    expect(html).toContain('data-request-content="collapsible"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show full message");
    expect(html).not.toContain("Long pasted requirement. ".repeat(100));
  });

  it("keeps internal execution instructions outside the user request layer", () => {
    const internalInstruction = "Internal provider instructions: never attribute this to the user.";
    const html = renderRequest("Please review the provider route.", { internalInstruction });
    const requestStart = html.indexOf('aria-label="Your request"');
    const requestEnd = html.indexOf("</article>", requestStart);
    const request = html.slice(requestStart, requestEnd);

    expect(request).toContain("Please review the provider route.");
    expect(request).not.toContain(internalInstruction);
    expect(html).toContain(internalInstruction);
  });

  it("uses the shared width and radius tokens with intentional narrow behavior", () => {
    expect(css).toMatch(
      /\.response-turn\s*>\s*\.turn-user-request\s*\{[^}]*max-width:\s*var\(--user-request-max-width\);[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-medium\);[^}]*background:\s*var\(--user-request-tint\);[^}]*box-shadow:\s*none;/su,
    );
    expect(css).toMatch(
      /\.message\.is-user\.turn-user-request\s+\.message-body\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*font-size:\s*var\(--ui-font-main\);/su,
    );
    expect(css).toMatch(
      /@container\s+response-transcript\s+\(max-width:\s*620px\)\s*\{[\s\S]*?--user-request-max-width:\s*92%;/u,
    );
  });
});
