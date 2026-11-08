import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceFilePreview } from "../../src/shared/contracts";
import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";
import {
  COMPOSER_PREFILL_EVENT,
  registerComposerPrefillTarget,
  type ComposerPrefillDetail,
} from "../../src/renderer/src/utils/composerPrefill";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const FILES_PROJECT = {
  projectRoot: "/work/project",
  projectId: "11111111-1111-4111-8111-111111111111",
} as const;

function sourcePreview(
  content: string,
  overrides: Partial<WorkspaceFilePreview> = {},
): WorkspaceFilePreview {
  return {
    path: "src/app.ts",
    content,
    truncated: false,
    language: "typescript",
    contentDigest: "a".repeat(64),
    modifiedAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

const CONTENT = Array.from(
  { length: 30 },
  (_, index) => index === 10 ? "const fence = \"````\";" : `const line${index + 1} = ${index + 1};`,
).join("\n");

/** Stands in for the chat's open message box and records what it receives. */
function capturePrefills(): ComposerPrefillDetail[] {
  const details: ComposerPrefillDetail[] = [];
  cleanups.push(registerComposerPrefillTarget({
    conversationId: () => CONVERSATION_ID,
    receive: (text) => details.push({ conversationId: CONVERSATION_ID, text }),
  }));
  return details;
}

function observePrefillRequests(): ComposerPrefillDetail[] {
  const details: ComposerPrefillDetail[] = [];
  const listener = (event: Event): void => {
    details.push((event as CustomEvent<ComposerPrefillDetail>).detail);
  };
  window.addEventListener(COMPOSER_PREFILL_EVENT, listener);
  cleanups.push(() => window.removeEventListener(COMPOSER_PREFILL_EVENT, listener));
  return details;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function renderPanel(
  preview: WorkspaceFilePreview,
  overrides: Partial<React.ComponentProps<typeof FilesPanel>> = {},
) {
  return render(
    <FilesPanel
      {...FILES_PROJECT}
      conversationId={CONVERSATION_ID}
      entries={[{ path: "src", kind: "directory" }]}
      preview={preview}
      selectedPath={preview.path}
      onSelectFile={vi.fn()}
      onLoadEntries={vi.fn(async () => ({ directory: "", entries: [], truncated: false }))}
      {...overrides}
    />,
  );
}

describe("FilesPanel source line selection", () => {
  it("selects a range with click and Shift+click and adds a fenced excerpt to the prompt", () => {
    const prefills = capturePrefills();
    const onComposerPrefill = vi.fn();
    const { container } = renderPanel(sourcePreview(CONTENT), { onComposerPrefill });

    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select line 10" }));
    fireEvent.click(screen.getByRole("button", { name: "Select line 12" }), { shiftKey: true });

    const toolbar = screen.getByRole("toolbar", { name: "Selected lines 10-12 of src/app.ts" });
    expect(toolbar).toBeInTheDocument();
    expect(container.querySelectorAll(".file-preview-line.is-selected")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Select line 11" }))
      .toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(prefills).toEqual([{
      conversationId: CONVERSATION_ID,
      text: [
        "src/app.ts lines 10-12:",
        "`````",
        "const line10 = 10;",
        "const fence = \"````\";",
        "const line12 = 12;",
        "`````",
      ].join("\n"),
    }]);
    expect(onComposerPrefill).toHaveBeenCalledWith("add");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("keeps the selection and says so when no message box for the chat is open", () => {
    const requests = observePrefillRequests();
    const onComposerPrefill = vi.fn();
    const { container } = renderPanel(sourcePreview(CONTENT), { onComposerPrefill });
    fireEvent.click(screen.getByRole("button", { name: "Select line 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Select line 4" }), { shiftKey: true });

    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    expect(requests).toHaveLength(1);
    expect(onComposerPrefill).not.toHaveBeenCalled();
    const toolbar = screen.getByRole("toolbar", { name: "Selected lines 3-4 of src/app.ts" });
    expect(container.querySelectorAll(".file-preview-line.is-selected")).toHaveLength(2);
    expect(toolbar.querySelector("[role='status']"))
      .toHaveTextContent("Open this chat's message box to add the selection.");

    fireEvent.click(screen.getByRole("button", { name: "Select line 6" }), { shiftKey: true });
    expect(screen.getByRole("toolbar", { name: "Selected lines 3-6 of src/app.ts" })
      .querySelector("[role='status']")).toBeEmptyDOMElement();

    const prefills = capturePrefills();
    fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
    expect(prefills).toHaveLength(1);
    expect(onComposerPrefill).toHaveBeenCalledWith("add");
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("supports keyboard selection, Escape, and Ask about with a trailing empty line", async () => {
    const prefills = capturePrefills();
    const onComposerPrefill = vi.fn();
    renderPanel(sourcePreview(CONTENT), { onComposerPrefill });

    const first = screen.getByRole("button", { name: "Select line 1" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Select line 2" }))
      .toHaveAttribute("tabindex", "-1");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select line 2" }))
      .toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Select line 2" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Select line 2" }), {
      key: "ArrowDown",
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Select line 4" }), {
      key: "Enter",
      shiftKey: true,
    });
    expect(screen.getByRole("toolbar", { name: "Selected lines 2-4 of src/app.ts" }))
      .toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Select line 4" }), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select line 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about" }));
    expect(prefills).toEqual([{
      conversationId: CONVERSATION_ID,
      text: "src/app.ts line 5:\n```\nconst line5 = 5;\n```\n\n",
    }]);
    expect(onComposerPrefill).toHaveBeenCalledWith("ask");
  });

  it("bounds the excerpt to 300 lines and says when it was trimmed", () => {
    const prefills = capturePrefills();
    const long = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n");
    renderPanel(sourcePreview(long));
    fireEvent.click(screen.getByRole("button", { name: "Select line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select line 400" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Add to prompt" }));
    const text = prefills[0]?.text ?? "";
    expect(text.startsWith("src/app.ts lines 1-400:\n```\nline 1\n")).toBe(true);
    expect(text).toContain("\nline 300\n```\n(Excerpt trimmed to lines 1-300");
    expect(text).not.toContain("line 301");
  });

  it("does not offer selection without a chat, in rendered Markdown, or past a truncated preview", () => {
    const view = renderPanel(sourcePreview(CONTENT), { conversationId: undefined });
    expect(screen.queryByRole("button", { name: "Select line 1" })).toBeNull();
    view.unmount();

    const markdown = renderPanel(sourcePreview("# Title\n\nBody", { path: "README.md" }));
    expect(screen.queryByRole("button", { name: "Select line 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("button", { name: "Select line 1" })).toBeInTheDocument();
    markdown.unmount();

    renderPanel(sourcePreview("one\ntwo\nthr", { truncated: true }));
    expect(screen.getByRole("button", { name: "Select line 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select line 3" })).toBeNull();
  });

  it("hides the selection actions while the file is being edited", () => {
    renderPanel(sourcePreview(CONTENT), {
      onSaveFile: vi.fn(),
      canSaveFile: () => true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Select line 3" }));
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit src/app.ts" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select line 3" })).toBeNull();
  });
});
