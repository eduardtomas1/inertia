import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const at = "2026-08-01T10:00:01.000Z";

const request: ChatMessage = {
  id: "message-1", conversationId, turnId: "turn-1", role: "user",
  content: "Explain **the build**", attachments: [], createdAt: at,
};
const answer: ChatMessage = {
  id: "answer-1", conversationId, turnId: "turn-1", role: "assistant",
  content: [
    "The **build** passes.",
    "",
    "See [the entry point](src/index.ts) and [the docs](https://example.com/docs).",
    "",
    "```ts",
    "const value = 1;",
    "```",
  ].join("\n"),
  attachments: [], createdAt: at,
};
const clientAnswer = [
  "Hi Ana,",
  "",
  "> The release ships on **Friday** with the new export.",
  "",
  "---",
  "",
  "| Item | Status |",
  "| --- | --- |",
  "| Export | Done |",
  "| Import | *Next week* |",
  "",
  "```sh",
  "npm run export",
  "```",
  "",
  "## Next steps",
  "",
  "- Review the [export docs](https://example.com/docs) and `config.json`",
  "- Read <https://example.com/faq>",
  "- Confirm the date",
  "  - nested detail",
  "    1. deeper step",
  "",
  "3. Third",
  "4. Fourth",
].join("\n");
const clientAnswerText = [
  "Hi Ana,",
  "",
  "The release ships on Friday with the new export.",
  "",
  "Item\tStatus",
  "Export\tDone",
  "Import\tNext week",
  "",
  "npm run export",
  "",
  "Next steps",
  "",
  "- Review the export docs (https://example.com/docs) and config.json",
  "- Read https://example.com/faq",
  "- Confirm the date",
  "  - nested detail",
  "    1. deeper step",
  "",
  "3. Third",
  "4. Fourth",
].join("\n");

const turn: AgentTurn = {
  id: "turn-1", conversationId, runId: "run-1", userMessageId: request.id,
  terminalAssistantMessageId: answer.id, providerId: "codex",
  modelSelection: {
    harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    backendProfileDisplayName: "Codex App Server", backendConfigurationRevision: 1,
    modelId: "gpt-5.6", alias: null, reasoningEffort: null, contextWindowOverride: null,
    providerOptions: {}, capabilities: [],
  },
  continuationIdentity: {
    harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    backendConfigurationRevision: 1, modelIdentity: "gpt-5.6", endpointIdentity: null,
  },
  harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
  model: "gpt-5.6", modelAlias: null, reasoningEffort: "xhigh",
  interactionMode: "build", accessMode: "supervised",
  providerSessionBefore: null, providerSessionAfter: null,
  requestedAt: at, startedAt: at, completedAt: at, status: "completed",
  terminalReason: "provider-completed", checkpointId: null,
  usageAtStart: null, usageAtCompletion: null, configurationRevision: 1,
  association: "authoritative", createdAt: at, updatedAt: at,
};

const bridge = {
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  copyText: vi.fn(async (_text: string) => true),
  openProjectPath: vi.fn(async () => ""),
  openExternal: vi.fn(async () => undefined),
  getPlatform: () => "darwin" as NodeJS.Platform,
};

function renderTimeline(onOpenTurnFile = vi.fn(), content = answer.content) {
  render(
    <div ref={createRef<HTMLDivElement>()}>
      <ResponseTimeline
        turns={[turn]} messages={[request, { ...answer, content }]}
        activities={[]} reasonings={[]} plans={[]} checkpoints={[]}
        projectRoot="/workspace/app" projectId={projectId} conversationId={conversationId}
        streamingText="" streamingReasoning="" approvals={[]} inputRequests={[]}
        showTimestamps={false} showThinking={false} defaultCodeWrap={false}
        autoCollapseWorkLog showChangedFileSummaries={false} checkpointRestoreDisabled={false}
        scrollElementRef={createRef<HTMLDivElement>()} timelineElementRef={createRef<HTMLDivElement>()}
        onRespondToApproval={async () => undefined} onRespondToInput={async () => undefined}
        onRevertCheckpoint={() => undefined} onOpenTurnDiff={() => undefined}
        onCompareTurnArtifacts={() => undefined} onOpenTurnFile={onOpenTurnFile}
        onStop={() => undefined}
      />
    </div>,
  );
  return { onOpenTurnFile };
}

const finalAnswer = () => screen.getByRole("article", { name: "Final assistant answer" });
const userRequest = () => screen.getByRole("article", { name: "Your request" });
const lastRequest = () => bridge.showContextMenu.mock.calls.at(-1)![0];

const settleMenu = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  vi.clearAllMocks();
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe("transcript context menus", () => {
  it("asks main for the message menu with ids and flags only and copies the rendered answer", async () => {
    renderTimeline();
    bridge.showContextMenu.mockResolvedValueOnce("copy-message");
    const paragraph = finalAnswer().querySelector("p")!;
    const event = fireEvent.contextMenu(paragraph, { clientX: 40, clientY: 60 });
    expect(event).toBe(false);
    expect(lastRequest()).toEqual({
      kind: "message", conversationId, role: "assistant", hasSelection: false, anchor: { x: 40, y: 60 },
    });
    expect(JSON.stringify(lastRequest())).not.toContain("build");
    await settleMenu();
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith(
      "The build passes.\n\nSee the entry point (src/index.ts) and the docs (https://example.com/docs).\n\nconst value = 1;",
    );
  });

  it("copies a client-ready answer without Markdown syntax from the menu and the Copy button", async () => {
    renderTimeline(vi.fn(), clientAnswer);
    bridge.showContextMenu.mockResolvedValueOnce("copy-message");
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    await settleMenu();
    fireEvent.click(screen.getByRole("button", { name: "Copy final answer" }));
    await settleMenu();
    expect(bridge.copyText.mock.calls).toEqual([[clientAnswerText], [clientAnswerText]]);
    for (const marker of ["> ", "---", "|", "```", "**", "*", "`"]) {
      expect(clientAnswerText).not.toContain(marker);
    }
  });

  it("copies the answer as Markdown", async () => {
    renderTimeline();
    bridge.showContextMenu.mockResolvedValueOnce("copy-markdown");
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    await settleMenu();
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith(answer.content);
  });

  it("copies the user's request as written", async () => {
    renderTimeline();
    bridge.showContextMenu.mockResolvedValueOnce("copy-message");
    fireEvent.contextMenu(userRequest().querySelector(".message-body")!);
    expect(lastRequest()).toMatchObject({ kind: "message", role: "user" });
    await settleMenu();
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith(request.content);
  });

  it("reports a selection inside the message so main can offer Copy", () => {
    renderTimeline();
    const paragraph = finalAnswer().querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
    fireEvent.contextMenu(paragraph);
    expect(lastRequest()).toMatchObject({ kind: "message", hasSelection: true });
  });

  it("offers Copy for a selection that crosses from the request into the answer", async () => {
    renderTimeline();
    const range = document.createRange();
    range.setStart(userRequest().querySelector(".message-body")!.firstChild!, 3);
    range.setEnd(finalAnswer().querySelector("p")!.firstChild!, 2);
    window.getSelection()!.addRange(range);
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    expect(lastRequest()).toMatchObject({ kind: "message", role: "assistant", hasSelection: true });
    await settleMenu();
    fireEvent.contextMenu(finalAnswer().querySelector("pre")!);
    expect(lastRequest()).toMatchObject({ kind: "code", hasSelection: false });
  });

  it("opens one menu at a time when the Menu key also fires a contextmenu event", async () => {
    renderTimeline();
    let settle!: (action: ContextMenuAction | null) => void;
    bridge.showContextMenu.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const article = userRequest();
    article.focus();
    fireEvent.keyDown(article, { key: "ContextMenu" });
    const duplicate = fireEvent.contextMenu(article);
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    expect(duplicate).toBe(false);
    expect(bridge.showContextMenu).toHaveBeenCalledOnce();
    await act(async () => settle(null));
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    expect(bridge.showContextMenu).toHaveBeenCalledTimes(2);
  });

  it("announces a copy the clipboard refused", async () => {
    renderTimeline();
    bridge.copyText.mockResolvedValueOnce(false);
    bridge.showContextMenu.mockResolvedValueOnce("copy-markdown");
    fireEvent.contextMenu(finalAnswer().querySelector("p")!);
    await settleMenu();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't copy. Try again or select the text manually.");
  });

  it("opens the menu from the keyboard at the focused message and keeps focus", async () => {
    renderTimeline();
    const article = userRequest();
    article.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 300, bottom: 80, width: 290, height: 60, toJSON: () => ({}),
    });
    article.focus();
    fireEvent.keyDown(article, { key: "F10", shiftKey: true });
    expect(lastRequest()).toMatchObject({ kind: "message", role: "user", anchor: { x: 10, y: 80 } });
    await settleMenu();
    fireEvent.keyDown(article, { key: "ContextMenu" });
    expect(bridge.showContextMenu).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(article);
  });

  it("offers Copy Code for a code block instead of the message menu", async () => {
    renderTimeline();
    bridge.showContextMenu.mockResolvedValueOnce("copy-code");
    fireEvent.contextMenu(finalAnswer().querySelector("pre")!);
    expect(bridge.showContextMenu).toHaveBeenCalledOnce();
    expect(lastRequest()).toEqual({ kind: "code", conversationId, hasSelection: false, anchor: { x: 0, y: 0 } });
    await settleMenu();
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith("const value = 1;");
  });

  it("offers path actions for a project link", async () => {
    const { onOpenTurnFile } = renderTimeline();
    const link = screen.getByRole("link", { name: /the entry point/u });
    fireEvent.contextMenu(link);
    expect(bridge.showContextMenu).toHaveBeenCalledOnce();
    expect(lastRequest()).toEqual({
      kind: "project-link", projectId, conversationId, relativePath: "src/index.ts", anchor: { x: 0, y: 0 },
    });
    await settleMenu();
    for (const action of ["open", "reveal", "copy-path", "copy-relative-path"] as const) {
      bridge.showContextMenu.mockResolvedValueOnce(action);
      fireEvent.contextMenu(link);
      await settleMenu();
    }
    expect(onOpenTurnFile).toHaveBeenCalledExactlyOnceWith("src/index.ts");
    expect(bridge.openProjectPath).toHaveBeenCalledExactlyOnceWith({
      projectId, conversationId, relativePath: "src/index.ts", action: "reveal",
    });
    expect(bridge.copyText.mock.calls).toEqual([["/workspace/app/src/index.ts"], ["src/index.ts"]]);
  });

  it("leaves web links to the native link menu", () => {
    renderTimeline();
    const event = fireEvent.contextMenu(screen.getByRole("link", { name: /the docs/u }));
    expect(event).toBe(true);
    expect(bridge.showContextMenu).not.toHaveBeenCalled();
  });
});
