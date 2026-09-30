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
  it.each(Object.keys(callbacks()))("refuses %s once the review scope has changed", (name) => {
    const handlers = callbacks();
    const dispatch = scopedReviewDispatch(handlers, scopeA, () => scopeB);

    expect((dispatch[name as keyof typeof dispatch] as (...args: unknown[]) => unknown)("argument", "comment"))
      .toBeUndefined();

    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it.each(Object.keys(callbacks()))("forwards %s unchanged within the scope it was opened in", (name) => {
    const handlers = callbacks();
    const dispatch = scopedReviewDispatch(handlers, scopeA, () => scopeA);

    void (dispatch[name as keyof typeof dispatch] as (...args: unknown[]) => unknown)("argument", "comment");

    expect(handlers[name as keyof typeof handlers]).toHaveBeenCalledExactlyOnceWith("argument", "comment");
  });
});
