// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import type { PreviewAnnotation, PreviewAnnotationDelivery } from "../../src/shared/preview-annotation";
import { PreviewPanel, type PreviewPanelProps } from "../../src/renderer/src/components/PreviewPanel";
import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import {
  PREVIEW_ANNOTATION_CONVERSATION_MISMATCH,
  useComposerPreviewAnnotations,
} from "../../src/renderer/src/components/composer/useComposerPreviewAnnotations";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";
import { useRef, useState } from "react";
import { PREVIEW_PICKER_OVERLAY_ATTR, previewPickerStartScript } from "../../src/main/preview-picker-script";

const sampleAnnotation: PreviewAnnotation = {
  pageUrl: "http://localhost:3000/pricing",
  selector: "section#pro >>> button.upgrade",
  role: "button",
  name: "Upgrade plan",
  bounds: { x: 40, y: 80, width: 140, height: 40 },
  html: '<button class="upgrade">Upgrade plan</button>',
  comment: "Make the button full width on mobile",
  tagName: "button",
  capturedAt: "2026-11-23T18:00:00.000Z",
};

const sampleAttachment: ChatAttachment = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "preview-annotation-1.png",
  path: "11111111-1111-4111-8111-111111111111",
  mimeType: "image/png",
  size: 2_048,
  previewAnnotation: sampleAnnotation,
};

function renderPreviewPanel(props: Partial<PreviewPanelProps> = {}) {
  return render(
    <PreviewPanel
      owner="primary"
      contextId="conv-1"
      url="http://127.0.0.1:4173/pricing"
      tabs={[{ id: "t1", title: "Pricing", url: "http://127.0.0.1:4173/pricing", loading: false }]}
      activeTabId="t1"
      onNavigate={vi.fn()}
      onOpenExternal={vi.fn()}
      onTogglePicker={vi.fn()}
      {...props}
    />,
  );
}

describe("PreviewPanel pick element toggle", () => {
  it("renders a keyboard-reachable labelled toggle that cancels on Escape when active", () => {
    const onTogglePicker = vi.fn();
    const view = renderPreviewPanel({ pickerActive: false, onTogglePicker });
    const toggle = screen.getByRole("button", { name: "Pick element" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);
    expect(onTogglePicker).toHaveBeenCalledTimes(1);

    view.rerender(
      <PreviewPanel
        owner="primary"
        contextId="conv-1"
        url="http://127.0.0.1:4173/pricing"
        tabs={[{ id: "t1", title: "Pricing", url: "http://127.0.0.1:4173/pricing", loading: false }]}
        activeTabId="t1"
        pickerActive
        onNavigate={vi.fn()}
        onOpenExternal={vi.fn()}
        onTogglePicker={onTogglePicker}
      />,
    );
    expect(screen.getByRole("button", { name: "Pick element" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onTogglePicker).toHaveBeenCalledTimes(2);
  });

  it("disables the toggle with an explanation while the agent controls the page", () => {
    renderPreviewPanel({ agentBusy: true });
    const toggle = screen.getByRole("button", { name: "Pick element" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute(
      "title",
      "Element picking is unavailable while the agent is controlling this page.",
    );
    expect(toggle).toHaveAccessibleDescription(
      "Element picking is unavailable while the agent is controlling this page.",
    );
  });

  it("disables the toggle when no local preview page is open", () => {
    renderPreviewPanel({ url: "" });
    expect(screen.getByRole("button", { name: "Pick element" })).toBeDisabled();
  });
});

describe("composer page annotation attachment chip and conversation ownership", () => {
  let listener: ((event: PreviewAnnotationDelivery) => void) | null = null;
  let commitAttachmentImport: ReturnType<typeof vi.fn>;
  let cancelAttachmentImport: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listener = null;
    commitAttachmentImport = vi.fn(async () => undefined);
    cancelAttachmentImport = vi.fn(async () => undefined);
    (window as unknown as { inertia: Record<string, unknown> }).inertia = {
      onPreviewAnnotation: (fn: (event: PreviewAnnotationDelivery) => void) => {
        listener = fn;
        return () => {
          if (listener === fn) listener = null;
        };
      },
      commitAttachmentImport,
      cancelAttachmentImport,
    };
  });

  function ComposerAnnotationHarness({ conversationId }: { conversationId: string }) {
    const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
    const [error, setError] = useState<string | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useComposerPreviewAnnotations(
      conversationId,
      async (lease: ComposerAttachmentImportLease) => {
        await lease.commit(lease.attachments.map(({ id }) => id));
        setAttachments((current) => [...current, ...lease.attachments]);
        return "adopted";
      },
      (message) => setError(message),
      textareaRef,
    );

    return (
      <div>
        {error && <p role="alert">{error}</p>}
        <textarea ref={textareaRef} aria-label="Message" />
        <ComposerAttachmentList
          attachments={attachments}
          onRemove={(item) => setAttachments((current) => current.filter(({ id }) => id !== item.id))}
        />
      </div>
    );
  }

  it("adopts a matching conversation's annotation as a structured chip without pasting into the draft", async () => {
    render(<ComposerAnnotationHarness conversationId="conv-owner" />);
    expect(listener).not.toBeNull();

    await act(async () => {
      listener!({
        conversationId: "conv-owner",
        selection: {
          batchId: "batch-1",
          attachments: [sampleAttachment],
        },
      });
    });

    expect(commitAttachmentImport).toHaveBeenCalledWith("batch-1", [sampleAttachment.id]);
    expect(cancelAttachmentImport).not.toHaveBeenCalled();

    const textarea = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    const list = screen.getByRole("list", { name: "Attachments" });
    const item = list.querySelector("li[data-preview-annotation='true']") as HTMLElement;
    expect(item).not.toBeNull();
    expect(within(item).getByText("Upgrade plan")).toBeInTheDocument();
    expect(within(item).getByText("Make the button full width on mobile")).toBeInTheDocument();

    fireEvent.click(within(item).getByRole("button", { name: "Remove page annotation Upgrade plan" }));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("refuses an annotation belonging to a different conversation and cancels its import lease", async () => {
    render(<ComposerAnnotationHarness conversationId="conv-active" />);
    expect(listener).not.toBeNull();

    await act(async () => {
      listener!({
        conversationId: "conv-other",
        selection: {
          batchId: "batch-mismatch",
          attachments: [sampleAttachment],
        },
      });
    });

    expect(commitAttachmentImport).not.toHaveBeenCalled();
    expect(cancelAttachmentImport).toHaveBeenCalledWith("batch-mismatch");
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(PREVIEW_ANNOTATION_CONVERSATION_MISMATCH);
  });
});

describe("PreviewPanel trusted element comment bar", () => {
  it("renders the trusted comment dialog in PreviewPanel and submits or cancels cleanly", () => {
    const onSubmitPickerComment = vi.fn();
    const onCancelPicker = vi.fn();
    renderPreviewPanel({
      pickerActive: true,
      pickerSelection: { label: "button#checkout-btn.cta", selector: "#checkout-btn" },
      onSubmitPickerComment,
      onCancelPicker,
    });
    const dialog = screen.getByRole("dialog", { name: "Comment on selected element" });
    expect(within(dialog).getByText("button#checkout-btn.cta")).toBeInTheDocument();
    const textarea = within(dialog).getByRole("textbox", { name: "Describe the change" });
    fireEvent.change(textarea, { target: { value: "Tighten padding" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    expect(onSubmitPickerComment).toHaveBeenCalledExactlyOnceWith("Tighten padding");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onCancelPicker).toHaveBeenCalledTimes(1);
  });
});

describe("preview picker overlay selection in Happy DOM", () => {
  it("selects a clicked element without mounting any comment input in the preview document and cancels on Escape", async () => {
    const sent: unknown[] = [];
    const shadows = new WeakMap<Element, ShadowRoot>();
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function patched(init: ShadowRootInit) {
      const root = origAttachShadow.call(this, init);
      shadows.set(this, root);
      return root;
    };
    const origElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    try {
      const target = document.createElement("button");
      target.id = "checkout-btn";
      target.className = "cta";
      target.textContent = "Checkout";
      target.getBoundingClientRect = () => ({
        left: 120, top: 90, right: 240, bottom: 130, width: 120, height: 40, x: 120, y: 90, toJSON: () => ({}),
      }) as DOMRect;
      document.body.appendChild(target);
      const pageClicked = vi.fn();
      target.addEventListener("click", pageClicked);
      (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [target];
      (globalThis as Record<string, unknown>).__inertiaPreviewPickerBridge = {
        send: (payload: unknown) => sent.push(payload),
      };

      const dispatchTrusted = (eventTarget: EventTarget, event: Event): void => {
        Object.defineProperty(event, "isTrusted", { value: true });
        eventTarget.dispatchEvent(event);
      };

      const run = new Function(previewPickerStartScript({ generation: 2 }));
      run();
      const host = document.querySelector(`[${PREVIEW_PICKER_OVERLAY_ATTR}="host"]`)!;
      expect(host.shadowRoot).toBeNull();
      expect(shadows.get(host)).not.toBeNull();
      expect(shadows.get(host)!.querySelector("textarea")).toBeNull();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(sent).toEqual([]);
      expect(document.querySelector(`[${PREVIEW_PICKER_OVERLAY_ATTR}="host"]`)).not.toBeNull();

      dispatchTrusted(window, new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(sent).toEqual([{ type: "cancelled", generation: 2 }]);
      expect(document.querySelector(`[${PREVIEW_PICKER_OVERLAY_ATTR}="host"]`)).toBeNull();

      sent.length = 0;
      run();
      dispatchTrusted(target, new PointerEvent("pointerdown", { button: 0, clientX: 150, clientY: 110, bubbles: true, cancelable: true }));
      dispatchTrusted(target, new MouseEvent("click", { button: 0, clientX: 150, clientY: 110, bubbles: true, cancelable: true }));
      expect(pageClicked).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({
        type: "selected",
        generation: 2,
        payload: { selector: "#checkout-btn", label: "button#checkout-btn.cta" },
      });
      expect(document.querySelector(`[${PREVIEW_PICKER_OVERLAY_ATTR}="host"]`)).toBeNull();
      target.remove();
    } finally {
      Element.prototype.attachShadow = origAttachShadow;
      (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint = origElementsFromPoint;
      delete (globalThis as Record<string, unknown>).__inertiaPreviewPickerBridge;
    }
  });
});
