import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DuoJudgeNotice } from "../../src/renderer/src/components/DuoJudgeNotice";
import {
  DuoJudgeNoticeContext,
  DuoJudgeNoticeSlot,
} from "../../src/renderer/src/components/DuoJudgeNoticeContext";
import type {
  DuoConversationComparison,
  DuoJudgeNotices,
} from "../../src/renderer/src/hooks/useDuoLaunchWatch";
import type {
  DuoComparisonState,
  ThreadStatus,
} from "../../src/shared/contracts";

const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const judgeConversationId = "77777777-7777-4777-8777-777777777777";

function entry(
  role: "judge" | "side",
  state: DuoComparisonState,
  error: string | null = null,
  conversationId: string | null = judgeConversationId,
  othersFinished = false,
): DuoConversationComparison {
  return {
    launchId,
    role,
    sideStarted: role === "side",
    othersFinished,
    comparison: { state, conversationId, turnId: null, attempt: 1, error },
  };
}

function renderNotice(
  value: DuoConversationComparison,
  {
    conversationStatus = "idle",
    pendingAction = null,
  }: {
    conversationStatus?: ThreadStatus;
    pendingAction?: "retry" | "cancel" | null;
  } = {},
) {
  const handlers = {
    onRetry: vi.fn(),
    onCancel: vi.fn(),
    onOpenJudge: vi.fn(),
    onReadVerdict: vi.fn(),
    onDismiss: vi.fn(),
  };
  const view = render(
    <DuoJudgeNotice
      entry={value}
      conversationStatus={conversationStatus}
      pendingAction={pendingAction}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
}

function noticeButtons(): string[] {
  return screen.queryAllByRole("button").map((button) => button.textContent ?? "");
}

describe("Duo judge notice", () => {
  it("tells the judge chat it is waiting for both chats", () => {
    const { container, onCancel } = renderNotice(entry("judge", "waiting"));
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("duo-judge-notice");
    expect(notice).not.toHaveClass("is-warning");
    expect(notice).not.toHaveClass("is-failed");
    expect(container.querySelector("svg.lucide-columns-2")).not.toBeNull();
    expect(notice.querySelector("strong")).toHaveTextContent(/^Waiting for both chats to finish$/u);
    expect(notice.querySelector("small")).toBeNull();
    expect(noticeButtons()).toEqual(["Cancel judge"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel judge" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("tells a finished side chat it is waiting for the other chat", () => {
    const { onOpenJudge } = renderNotice(entry("side", "waiting"));
    const notice = screen.getByRole("status");
    expect(notice.querySelector("strong")).toHaveTextContent(/^Waiting for the other chat$/u);
    expect(notice.querySelector("small")).toBeNull();
    expect(noticeButtons()).toEqual(["Open judge"]);
    fireEvent.click(screen.getByRole("button", { name: "Open judge" }));
    expect(onOpenJudge).toHaveBeenCalledWith(judgeConversationId);
  });

  it.each([
    ["judge", "Cancel judge"],
    ["side", "Open judge"],
  ] as const)("says the judge is starting on the %s chat once both chats finished", (role, action) => {
    renderNotice(entry(role, "waiting", null, judgeConversationId, true));
    const notice = screen.getByRole("status");
    expect(notice.querySelector("strong")).toHaveTextContent(/^Judge is starting$/u);
    expect(notice.querySelector("small")).toBeNull();
    expect(noticeButtons()).toEqual([action]);
  });

  it("stays hidden on a side chat until its own turn finishes", () => {
    const { container } = renderNotice(entry("side", "waiting"), {
      conversationStatus: "running",
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("warns on both chats while the judge waits for its folder", () => {
    const notice = "The judge is waiting for its folder.";
    renderNotice(entry("judge", "waiting", notice));
    const judge = screen.getByRole("status");
    expect(judge).toHaveClass("is-warning");
    expect(judge.querySelector("strong")).toHaveTextContent(/^Judge is waiting for its folder$/u);
    expect(judge.querySelector("small")).toBeNull();
    expect(noticeButtons()).toEqual(["Cancel judge"]);

    renderNotice(entry("side", "waiting", notice));
    const side = screen.getAllByRole("status")[1]!;
    expect(side).toHaveTextContent("Judge is waiting for its folder");
    expect(side.querySelector("button")).toHaveTextContent("Open judge");
  });

  it.each(["dispatching", "running"] as const)(
    "shows a comparing notice only on side chats while %s",
    (state) => {
      const { container } = renderNotice(entry("judge", state));
      expect(container).toBeEmptyDOMElement();
      renderNotice(entry("side", state));
      expect(screen.getByRole("status")).toHaveTextContent(
        "Judge is comparing both chats",
      );
      expect(noticeButtons()).toEqual(["Open judge"]);
    },
  );

  it.each(["judge", "side"] as const)(
    "offers retry and cancel on the %s chat when the judge failed",
    (role) => {
      const cause = "The judge turn failed: provider exited. Retry it or cancel the judge.";
      const { onRetry, onCancel } = renderNotice(entry(role, "failed", cause));
      const notice = screen.getByRole("status");
      expect(notice).toHaveClass("is-failed");
      expect(notice).toHaveTextContent("Judge didn't finish");
      expect(notice.querySelector("small")).not.toHaveAttribute("title");
      expect(notice.querySelector("small")).toHaveTextContent(/^provider exited\.$/u);
      expect(noticeButtons()).toEqual(["Retry", "Cancel judge"]);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel judge" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onCancel).toHaveBeenCalledTimes(1);
    },
  );

  it("shows an interrupted judge's saved cause", () => {
    renderNotice(entry(
      "judge",
      "interrupted",
      "The judge started, but its outcome became uncertain: the app closed. It was not retried automatically.",
    ));
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("is-warning");
    expect(notice.querySelector("strong")).toHaveTextContent(/^Judge was interrupted$/u);
    expect(notice.querySelector("small"))
      .toHaveTextContent(/^The judge started, but its outcome became uncertain: the app closed\.$/u);
    expect(noticeButtons()).toEqual(["Retry", "Cancel judge"]);
  });

  it.each(["failed", "interrupted"] as const)("shows only the status when a %s judge has no saved cause", (state) => {
    renderNotice(entry("judge", state));
    expect(screen.getByRole("status").querySelector("small")).toBeNull();
  });

  it("shows busy labels and disables both actions while one runs", () => {
    renderNotice(entry("judge", "failed", "Failed."), { pendingAction: "retry" });
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel judge" }))
      .toBeDisabled();
  });

  it("labels a running cancellation", () => {
    renderNotice(entry("judge", "waiting"), { pendingAction: "cancel" });
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });

  it("disables Open judge until the judge chat exists", () => {
    renderNotice(entry("side", "waiting", null, null));
    expect(screen.getByRole("button", { name: "Open judge" })).toBeDisabled();
  });

  it.each(["completed", "cancelled"] as const)(
    "shows nothing on the judge chat once the comparison is %s",
    (state) => {
      const { container } = renderNotice(entry("judge", state));
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("keeps a dismissable Verdict is in notice on a finished side chat", () => {
    const { onReadVerdict, onDismiss } = renderNotice(entry("side", "completed"));
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Verdict is in");
    expect(notice).not.toHaveClass("is-failed");
    expect(notice).not.toHaveClass("is-warning");
    expect(screen.getAllByRole("button").map((button) =>
      button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Read verdict", "Dismiss verdict notice"]);
    fireEvent.click(screen.getByRole("button", { name: "Read verdict" }));
    expect(onReadVerdict).toHaveBeenCalledWith(judgeConversationId);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss verdict notice" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides a cancelled comparison on side chats", () => {
    const { container } = renderNotice(entry("side", "cancelled"));
    expect(container).toBeEmptyDOMElement();
  });

  it("forgets a dismissed verdict only for the chat that dismissed it", async () => {
    const sourceA = "11111111-1111-4111-8111-111111111111";
    const sourceB = "22222222-2222-4222-8222-222222222222";
    const dismissed = new Set<string>();
    const notices = (): DuoJudgeNotices => ({
      comparisonForConversation: (conversationId) =>
        conversationId === judgeConversationId
          ? entry("judge", "completed")
          : entry("side", "completed"),
      pendingAction: () => null,
      retry: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      openJudge: vi.fn(),
      verdictDismissed: (launch, conversationId) => dismissed.has(`${launch}:${conversationId}`),
      dismissVerdict: (launch, conversationId) => {
        dismissed.add(`${launch}:${conversationId}`);
        view.rerender(tree());
      },
      alerts: [],
      dismissAlert: vi.fn(),
    });
    const tree = () => (
      <DuoJudgeNoticeContext.Provider value={notices()}>
        {[sourceA, sourceB, judgeConversationId].map((conversationId) => (
          <div key={conversationId} data-testid={conversationId}>
            <DuoJudgeNoticeSlot conversationId={conversationId} conversationStatus="idle" />
          </div>
        ))}
      </DuoJudgeNoticeContext.Provider>
    );
    const view = render(tree());
    await screen.findAllByText("Verdict is in");
    expect(screen.getAllByText("Verdict is in")).toHaveLength(2);
    expect(screen.getByTestId(judgeConversationId)).toBeEmptyDOMElement();

    fireEvent.click(within(screen.getByTestId(sourceA)).getByRole("button", {
      name: "Dismiss verdict notice",
    }));
    expect(dismissed).toEqual(new Set([`${launchId}:${sourceA}`]));
    expect(screen.getByTestId(sourceA)).toBeEmptyDOMElement();
    expect(within(screen.getByTestId(sourceB)).getByText("Verdict is in")).toBeVisible();
  });

  it("treats Read verdict as reading the notice for that chat", async () => {
    const sourceA = "11111111-1111-4111-8111-111111111111";
    const sourceB = "22222222-2222-4222-8222-222222222222";
    const dismissed = new Set<string>();
    const openJudge = vi.fn();
    const notices = (): DuoJudgeNotices => ({
      comparisonForConversation: () => entry("side", "completed"),
      pendingAction: () => null,
      retry: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      openJudge,
      verdictDismissed: (launch, conversationId) => dismissed.has(`${launch}:${conversationId}`),
      dismissVerdict: (launch, conversationId) => {
        dismissed.add(`${launch}:${conversationId}`);
        view.rerender(tree());
      },
      alerts: [],
      dismissAlert: vi.fn(),
    });
    const tree = () => (
      <DuoJudgeNoticeContext.Provider value={notices()}>
        {[sourceA, sourceB].map((conversationId) => (
          <div key={conversationId} data-testid={conversationId}>
            <DuoJudgeNoticeSlot conversationId={conversationId} conversationStatus="idle" />
          </div>
        ))}
      </DuoJudgeNoticeContext.Provider>
    );
    const view = render(tree());
    await screen.findAllByText("Verdict is in");

    fireEvent.click(within(screen.getByTestId(sourceA)).getByRole("button", {
      name: "Read verdict",
    }));

    expect(openJudge).toHaveBeenCalledWith(judgeConversationId);
    expect(dismissed).toEqual(new Set([`${launchId}:${sourceA}`]));
    expect(screen.getByTestId(sourceA)).toBeEmptyDOMElement();
    expect(within(screen.getByTestId(sourceB)).getByText("Verdict is in")).toBeVisible();
  });

  it("loads the notice for its conversation from the Duo context", async () => {
    const retry = vi.fn(async () => undefined);
    const notices: DuoJudgeNotices = {
      comparisonForConversation: (conversationId) =>
        conversationId === judgeConversationId
          ? entry("judge", "failed", "The judge could not start.")
          : null,
      pendingAction: () => null,
      retry,
      cancel: vi.fn(async () => undefined),
      openJudge: vi.fn(),
      verdictDismissed: () => false,
      dismissVerdict: vi.fn(),
      alerts: [],
      dismissAlert: vi.fn(),
    };
    const { container } = render(
      <DuoJudgeNoticeContext.Provider value={notices}>
        <DuoJudgeNoticeSlot
          conversationId="11111111-1111-4111-8111-111111111111"
          conversationStatus="idle"
        />
        <DuoJudgeNoticeSlot
          conversationId={judgeConversationId}
          conversationStatus="idle"
        />
      </DuoJudgeNoticeContext.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith(launchId);
    expect(container.querySelectorAll(".duo-judge-notice")).toHaveLength(1);
  });

  describe("keeps keyboard focus after a notice action", () => {
    const sideConversationId = "11111111-1111-4111-8111-111111111111";

    function focusHarness(role: "judge" | "side") {
      const conversationId = role === "judge" ? judgeConversationId : sideConversationId;
      let current = entry(role, "failed", "The judge turn failed: provider exited. Retry it or cancel the judge.");
      let pending: "retry" | "cancel" | null = null;
      let dismissed = false;
      const notices = (): DuoJudgeNotices => ({
        comparisonForConversation: () => current,
        pendingAction: () => pending,
        retry: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        openJudge: vi.fn(),
        verdictDismissed: () => dismissed,
        dismissVerdict: () => {
          dismissed = true;
          view.rerender(tree());
        },
        alerts: [],
        dismissAlert: vi.fn(),
      });
      const tree = () => (
        <DuoJudgeNoticeContext.Provider value={notices()}>
          <div className="composer-region">
            <DuoJudgeNoticeSlot conversationId={conversationId} conversationStatus="idle" />
            <textarea aria-label="Message" />
          </div>
        </DuoJudgeNoticeContext.Provider>
      );
      const view = render(tree());
      const update = (
        state: DuoComparisonState,
        nextPending: "retry" | "cancel" | null = null,
      ): void => {
        current = entry(role, state, state === "failed" ? "The judge turn failed: again." : null);
        pending = nextPending;
        view.rerender(tree());
      };
      const press = async (name: string, nextPending: "retry" | "cancel" | null = null): Promise<void> => {
        const button = await screen.findByRole("button", { name });
        button.focus();
        fireEvent.click(button);
        if (nextPending) {
          button.blur();
          pending = nextPending;
          view.rerender(tree());
        }
      };
      return { press, update };
    }

    it("moves focus to the composer when Retry removes the judge chat's notice", async () => {
      const { press, update } = focusHarness("judge");
      await press("Retry", "retry");
      update("running");
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
    });

    it("moves focus to Open judge when Retry starts the judge from a side chat", async () => {
      const { press, update } = focusHarness("side");
      await press("Retry", "retry");
      update("running");
      expect(screen.getByRole("button", { name: "Open judge" })).toHaveFocus();
    });

    it("returns focus to Retry when the judge fails again", async () => {
      const { press, update } = focusHarness("judge");
      await press("Retry", "retry");
      update("failed");
      expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
    });

    it("moves focus to the composer when the verdict notice is dismissed", async () => {
      const { press, update } = focusHarness("side");
      update("completed");
      await press("Dismiss verdict notice");
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
    });
  });

  it("renders nothing without a Duo context", () => {
    const { container } = render(
      <DuoJudgeNoticeSlot
        conversationId={judgeConversationId}
        conversationStatus="idle"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
