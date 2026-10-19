import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { appScratchRefsScript } from "../../src/server/runtime/app-under-test/snapshot-script";

/** A stand-in for the Browser's semantic scan: it clears refs and mints them from the document's state, as the real one does. */
const SCAN = `(() => {
  const state = globalThis.__inertiaAgentBrowser ??= {
    refs: new Map(), nodes: new WeakMap(), passwordNodes: new WeakSet(), passwordValues: new Set(), next: 1,
  };
  state.refs.clear();
  for (const node of globalThis.page) {
    let ref = state.nodes.get(node);
    if (!ref) {
      ref = "e" + state.next++;
      state.nodes.set(node, ref);
    }
    state.refs.set(ref, node);
  }
  if (globalThis.secret) state.passwordValues.add(globalThis.secret);
  if (globalThis.withhold) state.evidenceWithheld = globalThis.withhold;
  return [...state.refs.keys()];
})()`;

describe("App transport scratch-ref read", () => {
  it("lets a wait poll scan the document without minting, clearing or renumbering the agent's refs", () => {
    const save = { id: "save" };
    const cancel = { id: "cancel" };
    const appeared = { id: "appeared" };
    const context: Record<string, unknown> = { page: [save, cancel] };
    expect(runInNewContext(SCAN, context)).toEqual(["e1", "e2"]);
    const state = context.__inertiaAgentBrowser as { refs: Map<string, unknown>; next: number; passwordValues: Set<string>; evidenceWithheld?: string };

    context.page = [appeared];
    context.secret = "hunter22";
    context.withhold = "redaction-limit";
    expect(runInNewContext(appScratchRefsScript(SCAN), context)).toEqual(["e1"]);
    // The agent's refs and counter are untouched; the privacy memory the scan learned is kept.
    expect(context.__inertiaAgentBrowser).toBe(state);
    expect([...state.refs.entries()]).toEqual([["e1", save], ["e2", cancel]]);
    expect(state.next).toBe(3);
    expect(state.passwordValues.has("hunter22")).toBe(true);
    expect(state.evidenceWithheld).toBe("redaction-limit");

    // The next real snapshot gives the new control the next number, never one a wait used.
    context.page = [save, appeared];
    expect(runInNewContext(SCAN, context)).toEqual(["e1", "e3"]);
  });

  it("restores the agent's state even when the scan throws", () => {
    const context: Record<string, unknown> = { page: [{ id: "a" }] };
    runInNewContext(SCAN, context);
    const state = context.__inertiaAgentBrowser;
    expect(() => runInNewContext(appScratchRefsScript("(() => { throw new Error('scan failed'); })()"), context)).toThrow("scan failed");
    expect(context.__inertiaAgentBrowser).toBe(state);
  });
});
