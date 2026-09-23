import { render } from "@testing-library/react";
import { useCallback, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";

import {
  measureChatMinimumHeight,
  useChatMinimumHeight,
} from "../../src/renderer/src/hooks/useChatMinimumHeight";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function stubHeight(element: Element, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    { top: 0, bottom: height, height, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) },
  );
}

function workspaceFixture(): { workspace: HTMLElement; transcript: HTMLElement; composer: HTMLElement } {
  const workspace = document.createElement("div");
  workspace.className = "chat-workspace";
  const transcript = document.createElement("div");
  transcript.style.flexGrow = "1";
  transcript.style.paddingTop = "34px";
  transcript.style.paddingBottom = "25px";
  const composer = document.createElement("div");
  composer.style.marginTop = "4px";
  workspace.append(transcript, composer);
  stubHeight(transcript, 600);
  stubHeight(composer, 194);
  return { workspace, transcript, composer };
}

it("reserves the composer's full height and only the transcript's padding", () => {
  const { workspace } = workspaceFixture();
  document.body.append(workspace);
  expect(measureChatMinimumHeight(workspace)).toBe(34 + 25 + 4 + 194);
  workspace.remove();
});

it("ignores hidden and out-of-flow children", () => {
  const { workspace } = workspaceFixture();
  const overlay = document.createElement("div");
  overlay.style.position = "absolute";
  stubHeight(overlay, 400);
  const hidden = document.createElement("div");
  hidden.style.display = "none";
  stubHeight(hidden, 400);
  workspace.append(overlay, hidden);
  document.body.append(workspace);
  expect(measureChatMinimumHeight(workspace)).toBe(34 + 25 + 4 + 194);
  workspace.remove();
});

it("publishes the reserve on the host and clears it when the chat workspace leaves", async () => {
  const { workspace } = workspaceFixture();
  function Host(): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement>(null);
    const scopeRef = useRef<HTMLDivElement>(null);
    useChatMinimumHeight(hostRef, scopeRef);
    return <div ref={hostRef} data-testid="host"><div ref={scopeRef} data-testid="scope" /></div>;
  }
  const view = render(<Host />);
  const host = view.getByTestId("host");
  const scope = view.getByTestId("scope");
  expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("");
  scope.append(workspace);
  await vi.waitFor(() => {
    expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("257px");
  });
  workspace.remove();
  await vi.waitFor(() => {
    expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("");
  });
  view.unmount();
});

function ReplaceableHost({
  scene = "chat",
  scopeKey = "original",
}: {
  scene?: "chat" | "settings" | "split";
  scopeKey?: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const mountScope = useCallback((node: HTMLDivElement | null) => {
    scopeRef.current = node;
    if (node) node.append(workspaceFixture().workspace);
  }, []);
  useChatMinimumHeight(hostRef, scopeRef);
  return scene === "chat"
    ? <div ref={hostRef} data-testid="host"><div key={scopeKey} ref={mountScope} data-testid="scope" /></div>
    : <section>{scene}</section>;
}

it.each(["settings", "split"] as const)("binds the host when starting in %s and then entering chat", (scene) => {
  const view = render(<ReplaceableHost scene={scene} />);
  view.rerender(<ReplaceableHost />);
  const host = view.getByTestId("host");
  expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("257px");
  view.unmount();
  expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("");
});

it.each(["settings", "split"] as const)("rebinds a replacement chat host after visiting %s", (scene) => {
  const view = render(<ReplaceableHost />);
  const original = view.getByTestId("host");
  expect(original.style.getPropertyValue("--chat-minimum-height")).toBe("257px");
  view.rerender(<ReplaceableHost scene={scene} />);
  expect(original.style.getPropertyValue("--chat-minimum-height")).toBe("");
  view.rerender(<ReplaceableHost />);
  const replacement = view.getByTestId("host");
  expect(replacement).not.toBe(original);
  expect(replacement.style.getPropertyValue("--chat-minimum-height")).toBe("257px");
});

it("rebinds a replaced scope, retains observers on ordinary renders and cleans up both bindings", () => {
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor() { observers.push(this); }
  });
  const view = render(<ReplaceableHost />);
  const host = view.getByTestId("host");
  const originalScope = view.getByTestId("scope");
  expect(observers).toHaveLength(1);
  const disconnects = observers[0]!.disconnect.mock.calls.length;
  view.rerender(<ReplaceableHost />);
  expect(observers).toHaveLength(1);
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(disconnects);
  view.rerender(<ReplaceableHost scopeKey="replacement" />);
  expect(view.getByTestId("host")).toBe(host);
  expect(view.getByTestId("scope")).not.toBe(originalScope);
  expect(observers).toHaveLength(2);
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(disconnects + 1);
  const composer = view.getByTestId("scope").querySelector(".chat-workspace")!.lastElementChild!;
  expect(observers[1]!.observe).toHaveBeenCalledWith(composer);
  expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("257px");
  view.unmount();
  expect(host.style.getPropertyValue("--chat-minimum-height")).toBe("");
  expect(observers[1]!.disconnect).toHaveBeenCalledTimes(2);
});
