import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateEverythingDialog } from "../../src/renderer/src/components/sidebar/UpdateEverythingDialog";
import { restartBlockersSentence, runningChatsSentence, updateEverythingLabel } from "../../src/renderer/src/components/sidebar/appUpdatePresentation";
import type { UpdateEverythingPlan } from "../../src/renderer/src/components/sidebar/updateEverythingPlan";

const STORAGE_KEY = "inertia:update-everything:continue";

function plan(overrides: Partial<UpdateEverythingPlan> = {}): UpdateEverythingPlan {
  return {
    app: { from: "0.0.71", to: "0.0.72" },
    releasePageVersion: null,
    providers: [
      { providerId: "codex", label: "Codex", from: "0.112.0", to: "0.113.0" },
      { providerId: "claude", label: "Claude Code", from: "2.1.283", to: "2.1.295" },
    ],
    runningChats: 3,
    continuingChats: 3,
    workspaceRuns: 0,
    ...overrides,
  };
}

function show(value: UpdateEverythingPlan = plan()) {
  const onClose = vi.fn();
  const onUpdate = vi.fn();
  render(<UpdateEverythingDialog plan={value} onClose={onClose} onUpdate={onUpdate} />);
  return { onClose, onUpdate };
}

function body(): HTMLElement {
  return screen.getByRole("dialog");
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("update everything labels", () => {
  it("names one provider and counts several", () => {
    expect(updateEverythingLabel(true, ["Codex"])).toBe("Update Inertia and Codex");
    expect(updateEverythingLabel(true, ["Codex", "Claude Code"])).toBe("Update Inertia and 2 providers");
    expect(updateEverythingLabel(false, ["Codex"])).toBe("Update Codex");
    expect(updateEverythingLabel(false, ["Codex", "Claude Code"])).toBe("Update 2 providers");
    expect(updateEverythingLabel(false, ["Codex", "Claude Code", "Kimi Code"])).toBe("Update 3 providers");
  });

  it("chooses exactly one running chats sentence", () => {
    expect(runningChatsSentence(0, 0, true)).toBeNull();
    expect(runningChatsSentence(3, 3, true)).toBe("3 running chats will be interrupted and will continue after the update.");
    expect(runningChatsSentence(3, 3, false)).toBe("3 running chats will be interrupted.");
    expect(runningChatsSentence(3, 2, true)).toBe("3 running chats will be interrupted. 2 will continue after the update.");
    expect(runningChatsSentence(1, 1, true)).toBe("1 running chat will be interrupted and will continue after the update.");
    expect(runningChatsSentence(2, 0, true)).toBe("2 running chats will be interrupted.");
  });
});

describe("update everything restart blockers", () => {
  it("names the workspace runs that must finish before Inertia restarts", () => {
    expect(restartBlockersSentence(0)).toBeNull();
    expect(restartBlockersSentence(1)).toBe("1 workspace run must finish before Inertia restarts.");
    expect(restartBlockersSentence(2)).toBe("2 workspace runs must finish before Inertia restarts.");
  });

  it("shows the sentence only while Inertia is part of the run", () => {
    show(plan({ workspaceRuns: 2 }));
    expect(body()).toHaveTextContent("2 workspace runs must finish before Inertia restarts.");
    cleanup();
    show(plan({ workspaceRuns: 0 }));
    expect(body()).not.toHaveTextContent("must finish before Inertia restarts");
  });
});

describe("update everything dialog", () => {
  it("titles the dialog with the same joining rules and lists each item with its versions", () => {
    show();
    expect(screen.getByRole("heading", { name: "Update Inertia and 2 providers?" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Inertia 0.0.71 → 0.0.72",
      "Codex 0.112.0 → 0.113.0",
      "Claude Code 2.1.283 → 2.1.295",
    ]);
  });

  it("names a single provider and marks provider-managed updates without a known version", () => {
    show(plan({ app: null, providers: [{ providerId: "cursor", label: "Cursor", from: null, to: null }], runningChats: 0, continuingChats: 0 }));
    expect(screen.getByRole("heading", { name: "Update Cursor?" })).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Cursor (provider-managed update)");
    cleanup();
    show(plan({ providers: [{ providerId: "codex", label: "Codex", from: "0.112.0", to: "0.113.0" }] }));
    expect(screen.getByRole("heading", { name: "Update Inertia and Codex?" })).toBeInTheDocument();
  });

  it("explains a release-page update this build cannot install and leaves the app out", async () => {
    const { onUpdate } = show(plan({ app: null, releasePageVersion: "0.0.72" }));
    expect(screen.getByRole("heading", { name: "Update 2 providers?" })).toBeInTheDocument();
    expect(body()).toHaveTextContent("Inertia 0.0.72 is on the release page; this build cannot update itself.");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledWith({ providerIds: ["codex", "claude"], includeApp: false, continueChats: true });
  });

  it("shows no release-page line when the app updates in place", () => {
    show(plan({ releasePageVersion: "0.0.72" }));
    expect(body()).not.toHaveTextContent("release page");
  });

  it("switches the sentence with the checkbox and remembers the choice", () => {
    show();
    const checkbox = screen.getByRole("checkbox", { name: "Continue chats after the update" });
    expect(checkbox).toBeChecked();
    expect(body()).toHaveTextContent("3 running chats will be interrupted and will continue after the update.");
    fireEvent.click(checkbox);
    expect(body()).toHaveTextContent("3 running chats will be interrupted.");
    expect(body()).not.toHaveTextContent("continue after the update.");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
    cleanup();
    const { onUpdate } = show();
    expect(screen.getByRole("checkbox", { name: "Continue chats after the update" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledWith({ providerIds: ["codex", "claude"], includeApp: true, continueChats: false });
  });

  it("says how many chats can continue when some wait for approval or input", () => {
    show(plan({ continuingChats: 2 }));
    expect(body()).toHaveTextContent("3 running chats will be interrupted. 2 will continue after the update.");
  });

  it("hides the sentence and the checkbox without running chats", () => {
    show(plan({ runningChats: 0, continuingChats: 0 }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(body()).not.toHaveTextContent("running");
  });

  it("starts on Cancel, closes on Escape and Cancel, and restores focus", () => {
    render(<button type="button">Opener</button>);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<UpdateEverythingDialog plan={plan()} onClose={onClose} onUpdate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(opener).toHaveFocus();
  });

  it("sends every listed provider and the app when Update is pressed", () => {
    const { onUpdate, onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ providerIds: ["codex", "claude"], includeApp: true, continueChats: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});
