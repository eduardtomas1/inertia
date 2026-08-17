import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppUpdateNotice } from "../../src/renderer/src/components/AppUpdateNotice";
import type { AppUpdateStatus } from "../../src/shared/desktop";

const available: AppUpdateStatus = {
  revision: 1,
  state: "available",
  freshness: "fresh",
  delivery: "in-app",
  deliveryReason: null,
  installBlocker: null,
  progress: null,
  currentVersion: "0.0.10",
  latestVersion: "0.0.11",
  releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.11",
  checkedAt: "2030-01-02T03:04:05.000Z",
  lastAttemptedAt: "2030-01-02T03:04:05.000Z",
  message: "Inertia 0.0.11 is available.",
};

describe("application update notice", () => {
  it("offers explicit download and release-note choices without claiming a silent install", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateNotice, {
      status: available,
      onDismiss: () => undefined,
      onOpenRelease: () => undefined,
      onDownload: () => undefined,
      onCancelDownload: () => undefined,
      onInstall: () => undefined,
    }));

    expect(html).toContain('aria-label="Inertia application update"');
    expect(html).toContain("Inertia 0.0.11 is available");
    expect(html).toContain(">Download</button>");
    expect(html).toContain("Release notes</button>");
    expect(html).toContain('aria-label="Dismiss update"');
    expect(html).not.toContain("Install");
    expect(html).not.toContain("signed");
    expect(html).not.toContain(available.releaseUrl);
  });

  it("exposes bounded download progress and keeps active work non-dismissible", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateNotice, {
      status: {
        ...available,
        revision: 2,
        state: "downloading",
        progress: {
          percent: 42,
          transferredBytes: 42,
          totalBytes: 100,
          bytesPerSecond: 10,
        },
        message: "Downloading Inertia 0.0.11…",
      },
      onDismiss: () => undefined,
      onOpenRelease: () => undefined,
      onDownload: () => undefined,
      onCancelDownload: () => undefined,
      onInstall: () => undefined,
    }));

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain('aria-label="Dismiss update"');
  });
});
