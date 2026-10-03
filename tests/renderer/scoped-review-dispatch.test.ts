import { describe, expect, it, vi } from "vitest";

import { scopedReviewDispatch } from "../../src/renderer/src/utils/scopedReviewDispatch";

function callbacks() {
  return {
    onAsk: vi.fn(async () => undefined),
    onRequestRevision: vi.fn(async () => undefined),
    onRevert: vi.fn(async () => undefined),
    onSetReviewState: vi.fn(async () => undefined),
    onCreateNote: vi.fn(async () => undefined),
    onUpdateNote: vi.fn(async () => undefined),
    onDeleteNote: vi.fn(async () => undefined),
    onAddToPrompt: vi.fn(),
  };
}

const scopeA = JSON.stringify(["project-a", "chat-a", '5:.README.md']);
const scopeB = JSON.stringify(["project-a", "chat-b", '5:.README.md']);

describe("scoped review dispatch", () => {
  it("refuses a callback once the review scope has changed", () => {
    const handlers = callbacks();
    const dispatch = scopedReviewDispatch(handlers, scopeA, () => scopeB);

    expect((dispatch.onAsk as (...args: unknown[]) => unknown)("argument", "comment")).toBeUndefined();

    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it("forwards a callback unchanged within the scope it was opened in", () => {
    const handlers = callbacks();
    const dispatch = scopedReviewDispatch(handlers, scopeA, () => scopeA);

    void (dispatch.onAsk as (...args: unknown[]) => unknown)("argument", "comment");

    expect(handlers.onAsk).toHaveBeenCalledExactlyOnceWith("argument", "comment");
  });
});
