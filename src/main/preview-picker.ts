import type { BrowserWindow, Rectangle, WebContents } from "electron";

import { MAX_IMAGE_ATTACHMENT_BYTES } from "../shared/attachments.js";
import { browserEvidenceTextContainsSensitiveCredential } from "../shared/browser-evidence.js";
import type { PreviewPickerSelection } from "../shared/desktop.js";
import {
  PREVIEW_ANNOTATION_MAX_COMMENT_CHARS,
  PREVIEW_ANNOTATION_MAX_HTML_BYTES,
  PREVIEW_ANNOTATION_MAX_NAME_CHARS,
  PREVIEW_ANNOTATION_MAX_ROLE_CHARS,
  PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS,
  PREVIEW_ANNOTATION_MAX_TAG_CHARS,
  PREVIEW_ANNOTATION_SCREENSHOT_MARGIN_PX,
  previewAnnotationSchema,
  sanitizePreviewAnnotationHtml,
  shortPreviewAnnotationSelector,
  type PreviewAnnotation,
  type PreviewAnnotationBounds,
  type PreviewAnnotationDelivery,
} from "../shared/preview-annotation.js";
import { previewNavigationTarget } from "../shared/preview-url.js";
import type { AttachmentImportDocument, RendererAttachmentImportCoordinator } from "./attachment-import-ipc.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { withheldEvidenceMessage } from "./preview-agent-messages.js";
import { agentPageEvidencePrivacy } from "./preview-agent-page.js";
import { agentPageScreenshotPrivacy } from "./preview-agent-screenshot.js";
import { startPreviewPickerInPage, stopPreviewPickerInPage } from "./preview-picker-script.js";

const PREVIEW_PARTITION_PATTERN = /^inertia(?:-canary)?-preview-/u;
const MAX_SCREENSHOT_RESIZE_ATTEMPTS = 4;
const PREVIEW_ANNOTATION_MAX_RAW_HTML_CHARS = 32 * 1024;
const PICKER_SENSITIVE_SCREENSHOT_MESSAGE = "Element annotations are unavailable because the visible page shows a secret, or is too large for Inertia to check for one.";
const PICKER_UNREADABLE_SCREENSHOT_MESSAGE = "Element annotations are unavailable because the page has frames or shadow roots Inertia cannot inspect.";

export interface PreviewPickerSessionView {
  readonly contextId: string;
  readonly partition: string;
  readonly activeTabId: string;
  readonly busy: number;
  readonly viewportScale: number;
  pickerActive: boolean;
  pickerSelection: PreviewPickerSelection | null;
  readonly activeTab: {
    readonly id: string;
    readonly documentSequence: number;
    readonly contents: WebContents;
  } | null;
}

export interface PreviewAnnotationImportBridge {
  window(): BrowserWindow | null;
  document(): AttachmentImportDocument | null;
  registry(): AttachmentRegistry;
  readonly imports: RendererAttachmentImportCoordinator;
  readonly channel: string;
}

export function previewAnnotationImportDocument(
  window: BrowserWindow | null,
): AttachmentImportDocument | null {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
  const frame = window.webContents.mainFrame;
  if (!frame) return null;
  return {
    owner: window.webContents,
    processId: frame.processId,
    frameId: frame.routingId,
    frameToken: frame.frameToken,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPreviewPartition(partition: string): boolean {
  return PREVIEW_PARTITION_PATTERN.test(partition);
}

export function isPickablePreviewPage(partition: string, url: string): boolean {
  if (!isPreviewPartition(partition)) return false;
  try {
    return previewNavigationTarget(url).kind === "embed";
  } catch {
    return false;
  }
}

export function computePreviewCaptureRect(
  bounds: PreviewAnnotationBounds,
  viewport: { width: number; height: number },
  scale = 1,
  margin = PREVIEW_ANNOTATION_SCREENSHOT_MARGIN_PX,
): Rectangle | null {
  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const maxWidth = Math.floor(viewport.width * effectiveScale);
  const maxHeight = Math.floor(viewport.height * effectiveScale);
  if (maxWidth < 1 || maxHeight < 1) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  const rawLeft = bounds.x * effectiveScale;
  const rawTop = bounds.y * effectiveScale;
  const rawRight = (bounds.x + bounds.width) * effectiveScale;
  const rawBottom = (bounds.y + bounds.height) * effectiveScale;
  if (rawRight <= 0 || rawBottom <= 0 || rawLeft >= maxWidth || rawTop >= maxHeight) {
    return null;
  }

  const scaledMargin = margin * effectiveScale;
  const x = Math.max(0, Math.floor(rawLeft - scaledMargin));
  const y = Math.max(0, Math.floor(rawTop - scaledMargin));
  const right = Math.min(maxWidth, Math.ceil(rawRight + scaledMargin));
  const bottom = Math.min(maxHeight, Math.ceil(rawBottom + scaledMargin));
  const width = right - x;
  const height = bottom - y;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRawBounds(value: unknown): PreviewAnnotationBounds | null {
  if (!isPlainObject(value)) return null;
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0 || width > 32_768 || height > 32_768) return null;
  return { x, y, width, height };
}

export function buildValidatedPreviewAnnotation(
  rawPayload: unknown,
  authoritativePageUrl: string,
  capturedAt = new Date().toISOString(),
): {
  annotation: PreviewAnnotation;
  viewport: { width: number; height: number };
} {
  const target = previewNavigationTarget(authoritativePageUrl);
  if (target.kind !== "embed") {
    throw new Error("Only local preview pages can be annotated.");
  }
  if (!isPlainObject(rawPayload)) {
    throw new Error("The picked element payload was malformed.");
  }
  const selector = typeof rawPayload.selector === "string"
    ? rawPayload.selector.replace(/\0/gu, "").trim().slice(0, PREVIEW_ANNOTATION_MAX_SELECTOR_CHARS)
    : "";
  if (!selector) {
    throw new Error("The picked element did not produce a valid selector.");
  }
  const role = typeof rawPayload.role === "string"
    ? rawPayload.role.replace(/\0/gu, "").trim().slice(0, PREVIEW_ANNOTATION_MAX_ROLE_CHARS)
    : "";
  const name = typeof rawPayload.name === "string"
    ? rawPayload.name.replace(/\0/gu, "").trim().slice(0, PREVIEW_ANNOTATION_MAX_NAME_CHARS)
    : "";
  const tagName = typeof rawPayload.tagName === "string"
    ? rawPayload.tagName.replace(/\0/gu, "").trim().slice(0, PREVIEW_ANNOTATION_MAX_TAG_CHARS)
    : undefined;
  const comment = typeof rawPayload.comment === "string"
    ? rawPayload.comment.replace(/\0/gu, "").trim().slice(0, PREVIEW_ANNOTATION_MAX_COMMENT_CHARS)
    : "";
  const bounds = parseRawBounds(rawPayload.bounds);
  if (!bounds) {
    throw new Error("The picked element bounds were invalid.");
  }
  const rawHtml = typeof rawPayload.html === "string"
    ? rawPayload.html.slice(0, PREVIEW_ANNOTATION_MAX_RAW_HTML_CHARS)
    : "";
  const { html, truncated } = sanitizePreviewAnnotationHtml(rawHtml, PREVIEW_ANNOTATION_MAX_HTML_BYTES);

  const viewportWidth = finiteNumber(rawPayload.viewportWidth) ?? 0;
  const viewportHeight = finiteNumber(rawPayload.viewportHeight) ?? 0;

  const sanitizedUrl = new URL(target.url.toString());
  sanitizedUrl.username = "";
  sanitizedUrl.password = "";
  sanitizedUrl.search = "";
  sanitizedUrl.hash = "";

  const annotation = previewAnnotationSchema.parse({
    pageUrl: sanitizedUrl.toString(),
    selector,
    role,
    name,
    bounds,
    html,
    ...(truncated ? { htmlTruncated: true } : {}),
    comment,
    ...(tagName ? { tagName } : {}),
    capturedAt,
  });

  return {
    annotation,
    viewport: {
      width: viewportWidth > 0 ? viewportWidth : Math.ceil(bounds.x + bounds.width + PREVIEW_ANNOTATION_SCREENSHOT_MARGIN_PX),
      height: viewportHeight > 0 ? viewportHeight : Math.ceil(bounds.y + bounds.height + PREVIEW_ANNOTATION_SCREENSHOT_MARGIN_PX),
    },
  };
}

export async function captureCroppedElementScreenshot(
  contents: WebContents,
  bounds: PreviewAnnotationBounds,
  viewport: { width: number; height: number },
  viewportScale = 1,
): Promise<Buffer> {
  const rect = computePreviewCaptureRect(bounds, viewport, viewportScale);
  if (!rect) {
    throw new Error("The selected element is outside the visible preview area.");
  }
  let image = await contents.capturePage(rect);
  if (image.isEmpty()) {
    throw new Error("The selected element screenshot was empty.");
  }
  let png = image.toPNG();
  for (let attempt = 0; attempt < MAX_SCREENSHOT_RESIZE_ATTEMPTS && png.byteLength > MAX_IMAGE_ATTACHMENT_BYTES; attempt += 1) {
    const size = image.getSize();
    if (size.width <= 1 || size.height <= 1) break;
    image = image.resize({
      width: Math.max(1, Math.round(size.width * 0.72)),
      height: Math.max(1, Math.round(size.height * 0.72)),
      quality: "good",
    });
    png = image.toPNG();
  }
  if (png.byteLength === 0 || png.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("The selected element screenshot exceeded the image size limit.");
  }
  return png;
}

interface ActivePickState {
  readonly tabId: string;
  readonly documentSequence: number;
  readonly generation: number;
}

interface PendingSelectionState {
  readonly generation: number;
  readonly url: string;
  readonly rawPayload: Record<string, unknown>;
  readonly png: Buffer;
}

export interface PreviewPickerPrivacyChecks {
  readonly checkEvidencePrivacy?: (contents: WebContents) => Promise<{ withheld: Parameters<typeof withheldEvidenceMessage>[0] | null }>;
  readonly checkScreenshotPrivacy?: (contents: WebContents) => Promise<"clear" | "sensitive" | "unreadable">;
}

export class PreviewPickerCoordinator {
  readonly #activePicks = new Map<string, ActivePickState>();
  readonly #pendingSelections = new Map<string, PendingSelectionState>();
  readonly #sessionGenerations = new Map<string, number>();

  constructor(
    private readonly options: {
      readonly publish: (contextId: string) => void;
      readonly annotations?: PreviewAnnotationImportBridge;
      readonly privacy?: PreviewPickerPrivacyChecks;
    },
  ) {}

  #nextGeneration(contextId: string): number {
    const next = (this.#sessionGenerations.get(contextId) ?? 0) + 1;
    this.#sessionGenerations.set(contextId, next);
    return next;
  }

  #sendError(contextId: string, error: unknown): void {
    const bridge = this.options.annotations;
    if (!bridge) return;
    const window = bridge.window();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "The picked element could not be attached.";
    window.webContents.send(bridge.channel, { conversationId: contextId, error: message } satisfies PreviewAnnotationDelivery);
  }

  async #assertPageAllowsAnnotation(contents: WebContents): Promise<void> {
    const checkEvidence = this.options.privacy?.checkEvidencePrivacy ?? agentPageEvidencePrivacy;
    const checkScreenshot = this.options.privacy?.checkScreenshotPrivacy ?? agentPageScreenshotPrivacy;
    const evidence = await checkEvidence(contents);
    if (evidence.withheld) {
      throw new Error(withheldEvidenceMessage(evidence.withheld, "Element annotations are"));
    }
    const screenshot = await checkScreenshot(contents);
    if (screenshot === "sensitive") {
      throw new Error(PICKER_SENSITIVE_SCREENSHOT_MESSAGE);
    }
    if (screenshot !== "clear") {
      throw new Error(PICKER_UNREADABLE_SCREENSHOT_MESSAGE);
    }
  }

  isActive(contextId: string): boolean {
    return this.#activePicks.has(contextId) || this.#pendingSelections.has(contextId);
  }

  async start(
    session: PreviewPickerSessionView,
    point?: { readonly x: number; readonly y: number },
  ): Promise<boolean> {
    if (session.busy > 0) {
      throw new Error("Element picking is unavailable while the agent is controlling this page.");
    }
    const tab = session.activeTab;
    if (!tab || tab.contents.isDestroyed()) {
      throw new Error("Open a local preview page before picking an element.");
    }
    const url = tab.contents.getURL();
    if (!isPickablePreviewPage(session.partition, url)) {
      throw new Error("Element picking is only available on local preview pages.");
    }

    const generation = this.#nextGeneration(session.contextId);
    this.#pendingSelections.delete(session.contextId);
    this.#activePicks.set(session.contextId, {
      tabId: tab.id,
      documentSequence: tab.documentSequence,
      generation,
    });
    session.pickerActive = true;
    session.pickerSelection = null;
    this.options.publish(session.contextId);

    try {
      await startPreviewPickerInPage(tab.contents, point ? { point, generation } : { generation });
      if (this.#activePicks.get(session.contextId)?.generation !== generation || session.busy > 0) {
        if (!tab.contents.isDestroyed()) {
          void stopPreviewPickerInPage(tab.contents, generation).catch(() => undefined);
        }
        return false;
      }
      return true;
    } catch (error) {
      if (this.#activePicks.get(session.contextId)?.generation === generation) {
        this.#activePicks.delete(session.contextId);
        session.pickerActive = false;
        session.pickerSelection = null;
        this.options.publish(session.contextId);
      }
      throw error;
    }
  }

  cancel(session: PreviewPickerSessionView, publish = true): void {
    this.#nextGeneration(session.contextId);
    const hadPick = this.#activePicks.delete(session.contextId)
      || this.#pendingSelections.delete(session.contextId)
      || session.pickerActive
      || session.pickerSelection !== null;
    session.pickerActive = false;
    session.pickerSelection = null;
    if (!hadPick) return;
    const tab = session.activeTab;
    if (tab && !tab.contents.isDestroyed()) {
      void stopPreviewPickerInPage(tab.contents).catch(() => undefined);
    }
    if (publish) this.options.publish(session.contextId);
  }

  handleGuestEvent(
    contents: WebContents,
    rawEvent: unknown,
    session: PreviewPickerSessionView | null,
  ): void {
    if (!session || !isPlainObject(rawEvent)) return;
    const pick = this.#activePicks.get(session.contextId);
    const tab = session.activeTab;
    if (
      !pick
      || !tab
      || tab.contents !== contents
      || tab.id !== pick.tabId
      || tab.documentSequence !== pick.documentSequence
      || rawEvent.generation !== pick.generation
    ) {
      return;
    }

    if (rawEvent.type === "cancelled") {
      this.#activePicks.delete(session.contextId);
      this.#pendingSelections.delete(session.contextId);
      session.pickerActive = false;
      session.pickerSelection = null;
      this.options.publish(session.contextId);
      return;
    }

    if (rawEvent.type !== "selected") return;

    this.#activePicks.delete(session.contextId);
    if (session.busy > 0 || contents.isDestroyed()) {
      session.pickerActive = false;
      session.pickerSelection = null;
      this.options.publish(session.contextId);
      return;
    }

    void this.#prepareSelection(session, tab, pick.generation, rawEvent.payload);
  }

  async #prepareSelection(
    session: PreviewPickerSessionView,
    tab: NonNullable<PreviewPickerSessionView["activeTab"]>,
    generation: number,
    rawPayload: unknown,
  ): Promise<void> {
    try {
      if (!isPlainObject(rawPayload)) {
        throw new Error("The picked element payload was malformed.");
      }
      const url = tab.contents.getURL();
      if (!isPickablePreviewPage(session.partition, url)) {
        throw new Error("Element picking is only available on local preview pages.");
      }
      await this.#assertPageAllowsAnnotation(tab.contents);
      const { annotation, viewport } = buildValidatedPreviewAnnotation({ ...rawPayload, comment: "" }, url);
      if (
        browserEvidenceTextContainsSensitiveCredential(annotation.pageUrl)
        || browserEvidenceTextContainsSensitiveCredential(annotation.html)
        || browserEvidenceTextContainsSensitiveCredential(annotation.name)
        || browserEvidenceTextContainsSensitiveCredential(annotation.selector)
      ) {
        throw new Error(PICKER_SENSITIVE_SCREENSHOT_MESSAGE);
      }
      const png = await captureCroppedElementScreenshot(
        tab.contents,
        annotation.bounds,
        viewport,
        session.viewportScale,
      );
      await this.#assertPageAllowsAnnotation(tab.contents);
      if (
        session.busy > 0
        || tab.contents.isDestroyed()
        || this.#sessionGenerations.get(session.contextId) !== generation
      ) {
        return;
      }
      const rawLabel = typeof rawPayload.label === "string"
        ? rawPayload.label.replace(/\0/gu, "").trim().slice(0, 120)
        : "";
      const label = rawLabel || shortPreviewAnnotationSelector(annotation.selector);
      this.#pendingSelections.set(session.contextId, {
        generation,
        url,
        rawPayload: { ...rawPayload, comment: "" },
        png,
      });
      session.pickerActive = true;
      session.pickerSelection = { label, selector: annotation.selector };
      this.options.publish(session.contextId);
    } catch (error) {
      if (this.#sessionGenerations.get(session.contextId) === generation) {
        this.#pendingSelections.delete(session.contextId);
        session.pickerActive = false;
        session.pickerSelection = null;
        this.options.publish(session.contextId);
      }
      this.#sendError(session.contextId, error);
    }
  }

  async submit(session: PreviewPickerSessionView, comment: string): Promise<boolean> {
    const pending = this.#pendingSelections.get(session.contextId);
    if (!pending) return false;
    this.#pendingSelections.delete(session.contextId);
    this.#activePicks.delete(session.contextId);
    session.pickerActive = false;
    session.pickerSelection = null;
    this.options.publish(session.contextId);

    const bridge = this.options.annotations;
    if (!bridge || session.busy > 0) return false;
    const document = bridge.document();
    if (!document) return false;

    const sendDelivery = (delivery: PreviewAnnotationDelivery): void => {
      const window = bridge.window();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(bridge.channel, delivery);
    };

    let batchId: string | null = null;
    try {
      const { annotation } = buildValidatedPreviewAnnotation({ ...pending.rawPayload, comment }, pending.url);
      batchId = bridge.imports.begin(document);
      const fileName = `preview-annotation-${annotation.capturedAt.replace(/[:.]/gu, "-")}.png`;
      const attachments = await bridge.imports.importSelection(document, batchId, async (signal) => {
        const imported = await bridge.registry().import([{
          name: fileName,
          mimeType: "image/png",
          data: pending.png,
        }], signal);
        return imported.map((item) => bridge.registry().setPreviewAnnotation(item.id, annotation));
      });
      if (session.busy > 0 || this.#sessionGenerations.get(session.contextId) !== pending.generation) {
        await bridge.imports.cancel(document, batchId).catch(() => undefined);
        return false;
      }
      sendDelivery({
        conversationId: session.contextId,
        selection: { batchId, attachments },
      });
      return true;
    } catch (error) {
      if (batchId) {
        await bridge.imports.cancel(document, batchId).catch(() => undefined);
      }
      this.#sendError(session.contextId, error);
      return false;
    }
  }
}
