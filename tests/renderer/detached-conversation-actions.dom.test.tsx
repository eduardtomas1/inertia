import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { parse } from "@babel/parser";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Conversation, ServerEvent } from "../../src/shared/contracts";
import { useConversationNavigation } from "../../src/renderer/src/hooks/useConversationNavigation";
import type { DetachedChatWindowsController } from "../../src/renderer/src/hooks/useDetachedChatWindows";
import { conversation, deferred } from "./composer-fixtures";

const appSource = readFileSync(resolve("src/renderer/src/App.tsx"), "utf8");
const appAst = parse(appSource, { sourceType: "module", plugins: ["typescript", "jsx"] });

// Exercise the actual App callbacks with the real navigation hook, without
// replacing the callbacks or mounting unrelated runtime/desktop subsystems.
function bindAppAction(name: string, dependencies: {
  detachedChats: DetachedChatWindowsController;
  selectConversation: (conversation: Conversation) => void;
  setActionError: (message: string | null) => void;
  conversation: Conversation;
}): (conversation: Conversation) => void {
  const exported = appAst.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (exported?.declaration.type !== "FunctionDeclaration") throw new Error("App was not found");
  const variable = exported.declaration.body.body.flatMap((node) =>
    node.type === "VariableDeclaration" ? node.declarations : [],
  ).find((node) => node.id.type === "Identifier" && node.id.name === name);
  const expression = variable?.init?.type === "CallExpression" ? variable.init.arguments[0] : variable?.init;
  if (expression?.type !== "ArrowFunctionExpression" || expression.start == null || expression.end == null) {
    throw new Error("App action was not found");
  }
  const compiled = stripTypeScriptTypes(`(${appSource.slice(expression.start, expression.end)})`);
  const create = new Function(...Object.keys(dependencies), `return ${compiled}`) as
    (...values: unknown[]) => (conversation: Conversation) => void;
  return create(...Object.values(dependencies));
}

const primary = conversation("primary");
const target = conversation("detached");
const newer = conversation("newer");
const ok: ServerEvent = { type: "request.ok", requestId: "selection" };

function fixture(action: string) {
  const focused = deferred<boolean>();
  const focus = vi.fn(() => focused.promise);
  const select = vi.fn(async () => ok);
  const error = vi.fn();
  const detachedChats: DetachedChatWindowsController = {
    ready: true, windows: [{ conversationId: target.id, alwaysOnTop: false }],
    conversationIds: new Set([target.id]), atLimit: false, focus, open: vi.fn(),
  };
  const generation = { current: 0 };
  const hook = renderHook(() => useConversationNavigation({
    snapshot: null, conversation: primary, splitConversation: null, detachedChats,
    exitGlobalChat: vi.fn(), conversationSelectionGenerationRef: generation,
    splitSelectionTransitionsRef: { current: 0 }, setSuppressedMainConversationIds: vi.fn(),
    setSecondaryPaneFirst: vi.fn(), selectConversationCommand: select,
    updateSplitConversationId: vi.fn(), request: vi.fn(), setActionError: error,
  }));
  const invoke = bindAppAction(action, {
    detachedChats, selectConversation: hook.result.current.selectConversation,
    setActionError: error, conversation: primary,
  });
  return { invoke, hook, focused, focus, select, error };
}

describe.each(["openConversationInWindow", "openConversationInSplit"])("%s detached ownership", (action) => {
  it.each(["false", "rejected"])("falls back to main when native focus is %s", async (outcome) => {
    const f = fixture(action);
    act(() => f.invoke(target));
    expect(f.focus).toHaveBeenCalledExactlyOnceWith(target.id);
    expect(f.select).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "false") f.focused.resolve(false);
      else f.focused.reject(new Error("Synthetic native focus failure"));
    });
    expect(f.select).toHaveBeenCalledExactlyOnceWith("conversation.select", target.id, undefined);
    expect(f.error.mock.calls.flat()).not.toContainEqual(expect.any(String));
  });

  it("retains a successfully focused detached owner", async () => {
    const f = fixture(action);
    act(() => f.invoke(target));
    await act(async () => f.focused.resolve(true));
    expect(f.focus).toHaveBeenCalledExactlyOnceWith(target.id);
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each(["false", "rejected"])("does not override newer navigation after late %s focus", async (outcome) => {
    const f = fixture(action);
    act(() => f.invoke(target));
    await act(async () => f.hook.result.current.selectConversation(newer));
    await act(async () => {
      if (outcome === "false") f.focused.resolve(false);
      else f.focused.reject(new Error("Synthetic stale focus failure"));
    });
    expect(f.select).toHaveBeenCalledExactlyOnceWith("conversation.select", newer.id, undefined);
    expect(f.error.mock.calls.flat()).not.toContainEqual(expect.any(String));
  });
});
