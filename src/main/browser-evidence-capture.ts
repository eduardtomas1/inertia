import type { NativeImage, Session, WebContents } from "electron";

import {
  type AgentBrowserActivity,
} from "../shared/agent-browser.js";
import {
  MAX_BROWSER_EVIDENCE_THUMBNAIL_BYTES,
  type BrowserEvidenceImage,
  type BrowserEvidenceSnapshot,
} from "../shared/browser-evidence.js";
import {
  BrowserEvidenceLedger,
  type BrowserEvidenceAuthority,
} from "./browser-evidence-ledger.js";

const MAX_PREVIEW_PAGE_EVIDENCE_EVENTS = 160;

export interface BrowserEvidencePage {
  tabId: string;
  pageNumber: number;
  documentSequence: number;
  contents: WebContents;
}

interface BrowserEvidenceLocation {
  tabId: string;
  pageNumber: number;
  documentSequence: number;
  authority?: BrowserEvidenceAuthority;
}

interface BrowserEvidenceCaptureOptions {
  isLive(): boolean;
  isCurrent(page: BrowserEvidencePage): boolean;
  publish(): void;
  sensitiveDocument(contents: WebContents): Promise<boolean>;
}

/** Owns bounded, ephemeral page evidence for one exact Browser slot. */
export class BrowserEvidenceCapture {
  readonly #ledger = new BrowserEvidenceLedger();
  readonly #networkRequests = new Map<number, BrowserEvidenceLocation>();
  #session: Session | null = null;
  #pageEvents = 0;
  #limited = false;

  constructor(private readonly options: BrowserEvidenceCaptureOptions) {}

  snapshot(): BrowserEvidenceSnapshot {
    return this.#ledger.snapshot();
  }

  image(id: string): BrowserEvidenceImage | null {
    return this.#ledger.image(id);
  }

  close(): void {
    if (this.#session) {
      this.#session.webRequest.onBeforeRequest(null);
      this.#session.webRequest.onCompleted(null);
      this.#session.webRequest.onErrorOccurred(null);
      this.#session = null;
    }
    this.#networkRequests.clear();
    this.#ledger.clear();
  }

  installSession(
    browserSession: Session,
    locate: (webContentsId: unknown) => (BrowserEvidenceLocation | null),
  ): void {
    if (this.#session) return;
    this.#session = browserSession;
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const location = locate(details.webContentsId);
      if (location && this.options.isLive()) {
        if (this.#networkRequests.size >= 256) {
          const oldest = this.#networkRequests.keys().next().value;
          if (typeof oldest === "number") this.#networkRequests.delete(oldest);
          if (this.#ledger.markOmitted()) this.options.publish();
        }
        this.#networkRequests.set(details.id, location);
      }
      callback({});
    });
    const recordFailure = (details: {
      id: number;
      url: string;
      method: string;
      resourceType: string;
      statusCode?: number;
      error?: string;
    }): void => {
      const location = this.#networkRequests.get(details.id);
      this.#networkRequests.delete(details.id);
      if (
        !location
        || !this.options.isLive()
        || details.error === "net::ERR_ABORTED"
        || !this.#reservePageEvent()
      ) return;
      this.#ledger.recordNetworkFailure({
        ...location,
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        outcome: details.statusCode ?? details.error,
      });
      this.options.publish();
    };
    browserSession.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400 && details.statusCode <= 599) {
        recordFailure(details);
      } else {
        this.#networkRequests.delete(details.id);
      }
    });
    browserSession.webRequest.onErrorOccurred(recordFailure);
  }

  recordNavigation(
    page: BrowserEvidencePage,
    url: string,
    sameDocument: boolean,
    authority?: BrowserEvidenceAuthority,
  ): void {
    if (!this.options.isLive() || !this.#reservePageEvent()) return;
    this.#ledger.recordNavigation({
      ...this.#location(page, authority),
      url,
      sameDocument,
    });
  }

  recordConsoleError(
    page: BrowserEvidencePage,
    message: unknown,
    authority?: BrowserEvidenceAuthority,
  ): void {
    if (!this.options.isLive() || !this.#reservePageEvent()) return;
    const boundedMessage = typeof message === "string"
      ? message.slice(0, 8_192)
      : "";
    const commit = (sensitiveDocument: boolean): void => {
      if (!this.options.isLive() || !this.options.isCurrent(page)) return;
      this.#ledger.recordConsoleError({
        ...this.#location(page, authority),
        message: boundedMessage,
        sensitiveDocument,
      });
      this.options.publish();
    };
    void this.options.sensitiveDocument(page.contents)
      .then(commit, () => commit(true));
  }

  recordAgentAction(
    page: BrowserEvidencePage,
    summary: string,
    occurredAt: string,
    authority?: BrowserEvidenceAuthority,
  ): void {
    this.#ledger.recordAgentAction({
      ...this.#location(page, authority),
      occurredAt,
      summary,
    });
  }

  recordScreenshot(
    page: BrowserEvidencePage,
    url: string,
    image: NativeImage,
    authority?: BrowserEvidenceAuthority,
  ): AgentBrowserActivity {
    const occurredAt = new Date().toISOString();
    const size = image.getSize();
    this.#ledger.recordScreenshot({
      ...this.#location(page, authority),
      occurredAt,
      url,
      data: this.#boundedThumbnailData(image),
      width: size.width,
      height: size.height,
    });
    return {
      action: "screenshot",
      label: "Agent captured a screenshot",
      tabId: page.tabId,
      at: occurredAt,
    };
  }

  #location(
    page: BrowserEvidencePage,
    authority?: BrowserEvidenceAuthority,
  ): BrowserEvidenceLocation {
    return {
      tabId: page.tabId,
      pageNumber: page.pageNumber,
      documentSequence: page.documentSequence,
      authority,
    };
  }

  #reservePageEvent(): boolean {
    if (this.#pageEvents < MAX_PREVIEW_PAGE_EVIDENCE_EVENTS) {
      this.#pageEvents += 1;
      return true;
    }
    if (!this.#limited) {
      this.#limited = true;
      if (this.#ledger.markOmitted()) this.options.publish();
    }
    return false;
  }

  #boundedThumbnailData(source: NativeImage): string | null {
    const sourceSize = source.getSize();
    const scale = Math.min(1, 512 / sourceSize.width, 320 / sourceSize.height);
    let image = scale < 1
      ? source.resize({
          width: Math.max(1, Math.floor(sourceSize.width * scale)),
          height: Math.max(1, Math.floor(sourceSize.height * scale)),
          quality: "good",
        })
      : source;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const png = image.toPNG();
      if (png.byteLength > 0 && png.byteLength <= MAX_BROWSER_EVIDENCE_THUMBNAIL_BYTES) {
        return png.toString("base64");
      }
      image = image.resize({
        width: Math.max(1, Math.floor(image.getSize().width * 0.72)),
        quality: "good",
      });
    }
    return null;
  }
}

export type { BrowserEvidenceAuthority };
