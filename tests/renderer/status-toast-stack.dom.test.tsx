import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppStatusOverlays, StatusToastStack } from "../../src/renderer/src/components/AppStatusOverlays";

const appUpdate = {
  status: null,
  checking: false,
  visible: false,
  error: null,
  check: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  cancelDownload: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  dismiss: vi.fn(),
  dismissError: vi.fn(),
  openRelease: vi.fn(async () => undefined),
};

describe("status toast stack", () => {
  it("renders error toasts in the chat-area stack instead of the window overlays", () => {
    const { container } = render(
      <div className="workspace-frame">
        <StatusToastStack
          appUpdate={appUpdate}
          providerQuotaNotices={{ notices: [], dismiss: vi.fn() }}
          error="Git is not installed or could not be started."
          onDismissError={vi.fn()}
        />
      </div>,
    );
    const stack = container.querySelector(".workspace-frame > .status-overlay-stack");
    expect(stack).not.toBeNull();
    expect(stack).toContainElement(screen.getByRole("alert"));
    expect(screen.getByRole("alert")).toHaveTextContent("Git is not installed or could not be started.");

    const overlays = render(
      <AppStatusOverlays
        providerAuth={{ provider: null } as never}
        appUpdate={appUpdate}
        providerQuotaNotices={{ notices: [], dismiss: vi.fn() }}
        error="Git is not installed or could not be started."
        databaseRecoveryNotice={null}
        onDismissDatabaseRecoveryNotice={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyRecoveryReport={vi.fn(async () => undefined)}
      />,
    );
    expect(overlays.container.querySelector(".status-overlay-stack")).toBeNull();
  });
});
