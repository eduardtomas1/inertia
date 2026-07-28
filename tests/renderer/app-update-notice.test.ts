import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppUpdateNotice } from "../../src/renderer/src/components/AppUpdateNotice";
import type { AppUpdateStatus } from "../../src/shared/desktop";

const available: AppUpdateStatus = {
  state: "available",
  freshness: "fresh",
  currentVersion: "0.0.10",
  latestVersion: "0.0.11",
  releaseUrl: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.11",
  checkedAt: "2030-01-02T03:04:05.000Z",
  lastAttemptedAt: "2030-01-02T03:04:05.000Z",
  message: "Inertia 0.0.11 is available.",
};

describe("application update notice", () => {
  it("offers an explicit release-page choice without claiming a silent install", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateNotice, {
      status: available,
      onDismiss: () => undefined,
      onOpenRelease: () => undefined,
    }));

    expect(html).toContain('aria-label="Inertia update available"');
    expect(html).toContain("Inertia 0.0.11 is ready");
    expect(html).toContain(">View release</button>");
    expect(html).toContain('aria-label="Dismiss update"');
    expect(html).toContain("Review the release before downloading");
    expect(html).not.toContain("Install");
    expect(html).not.toContain("signed");
    expect(html).not.toContain(available.releaseUrl);
  });
});
