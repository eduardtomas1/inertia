import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageEvidencePrivacy,
  agentPageHasSensitiveEvidence,
  installAgentPagePrivacyGuard,
} from "../../src/main/preview-agent-page";

describe("agent Browser privacy classification", () => {
  it("keeps a large document inspectable and records that its scan was bounded", async () => {
    let nextNodeCalls = 0;
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        passwordNodes: new WeakSet(),
        passwordValues: new Set(),
      } as Record<string, unknown>,
      document: {
        documentElement: {},
        createNodeIterator: () => ({
          nextNode: () => {
            nextNodeCalls += 1;
            return { tagName: "DIV" };
          },
        }),
      },
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageEvidencePrivacy(contents as never)).resolves.toEqual({ withheld: null });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(false);
    expect(nextNodeCalls).toBe(8_002);
    expect(context.__inertiaAgentBrowser.scanLimitReached).toBe(true);
    expect(context.__inertiaAgentBrowser.evidenceWithheld).toBeUndefined();
  });

  it("classifies exactly why a document's evidence is withheld", async () => {
    const state = {
      privacyGuardInstalled: true,
      passwordNodes: new WeakSet(),
      passwordValues: new Set<string>(),
    } as Record<string, unknown>;
    const context = {
      __inertiaAgentBrowser: state,
      document: {
        documentElement: {},
        createNodeIterator: (): unknown => ({ nextNode: () => null }),
      } as Record<string, unknown>,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await expect(agentPageEvidencePrivacy(contents as never)).resolves.toEqual({ withheld: null });
    state.framesObserved = true;
    state.shadowRootsObserved = true;
    state.scanLimitReached = true;
    await expect(agentPageEvidencePrivacy(contents as never)).resolves.toEqual({ withheld: null });
    state.evidenceWithheld = "hidden-input";
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "hidden-input" });
    state.evidenceWithheld = "credential-signal";
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "credential-signal" });
    (state.passwordValues as Set<string>).add("hunter2");
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "password" });
    await expect(agentPageHasSensitiveEvidence(contents as never)).resolves.toBe(true);

    (state.passwordValues as Set<string>).clear();
    state.evidenceWithheld = undefined;
    context.document.createNodeIterator = undefined;
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "credential-signal" });
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(undefined);
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "credential-signal" });
  });

  it("bounds document-start privacy discovery on a dense DOM", async () => {
    let nextNodeCalls = 0;
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const context = {
      document: {
        documentElement: { nodeType: 1, tagName: "HTML" },
        addEventListener: vi.fn(),
        createNodeIterator: () => ({
          nextNode: () => {
            nextNodeCalls += 1;
            return { nodeType: 1, tagName: "DIV" };
          },
        }),
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(nextNodeCalls).toBe(4_001);
    expect(runInNewContext(
      "({ ...globalThis.__inertiaAgentBrowser, refs: undefined, nodes: undefined, passwordNodes: undefined, passwordValues: undefined, privacyObserver: undefined })",
      context,
    )).toMatchObject({ scanLimitReached: true });
    expect(runInNewContext("globalThis.__inertiaAgentBrowser.evidenceWithheld", context))
      .toBeUndefined();
  });

  it("records a consumed declarative shadow template and an added frame as not inspected", async () => {
    let callback: ((records: unknown[]) => void) | undefined;
    class MutationObserver {
      constructor(observer: (records: unknown[]) => void) { callback = observer; }
      observe(): void {}
    }
    const documentElement = { nodeType: 1, tagName: "HTML", matches: () => false };
    const template = {
      nodeType: 1,
      tagName: "TEMPLATE",
      matches: (selector: string) => selector.includes("template[shadowrootmode]"),
    };
    const frame = {
      nodeType: 1,
      tagName: "IFRAME",
      matches: (selector: string) => selector.split(",").includes("iframe"),
    };
    const context = {
      document: {
        documentElement,
        addEventListener: vi.fn(),
        createNodeIterator: (root: unknown) => {
          let next = root;
          return {
            nextNode: () => {
              const value = next;
              next = null;
              return value;
            },
          };
        },
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(callback).toBeTypeOf("function");
    const observed = (): unknown => runInNewContext(
      "[globalThis.__inertiaAgentBrowser.shadowRootsObserved, globalThis.__inertiaAgentBrowser.framesObserved, globalThis.__inertiaAgentBrowser.evidenceWithheld]",
      context,
    );
    expect(observed()).toEqual([undefined, undefined, undefined]);
    callback!([{
      type: "childList",
      target: documentElement,
      oldValue: null,
      removedNodes: [template],
      addedNodes: [],
    }]);
    expect(observed()).toEqual([true, undefined, undefined]);
    callback!([{
      type: "childList",
      target: documentElement,
      oldValue: null,
      removedNodes: [],
      addedNodes: [frame],
    }]);
    expect(observed()).toEqual([true, true, undefined]);
  });

  it("shares one bounded scan budget across each mutation callback", async () => {
    let callback: ((records: unknown[]) => void) | undefined;
    let attributeTargetsInspected = 0;
    let addedNodesInspected = 0;
    class MutationObserver {
      constructor(observer: (records: unknown[]) => void) { callback = observer; }
      observe(): void {}
    }
    const documentElement = { nodeType: 1, tagName: "HTML" };
    const context = {
      document: {
        documentElement,
        addEventListener: vi.fn(),
        createNodeIterator: (root: { nodeType?: number }) => {
          let first = true;
          return {
            nextNode: () => {
              if (!first) return null;
              first = false;
              if (root.nodeType === 1 && root !== documentElement) {
                addedNodesInspected += 1;
              }
              return root;
            },
          };
        },
      },
      MutationObserver,
    };
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    };

    await installAgentPagePrivacyGuard(contents as never);
    expect(callback).toBeTypeOf("function");
    const attributeRecords = Array.from({ length: 5_000 }, () => ({
      type: "attributes",
      get target() {
        attributeTargetsInspected += 1;
        return { tagName: "DIV" };
      },
      oldValue: null,
      removedNodes: [],
      addedNodes: [],
    }));
    callback!(attributeRecords);
    expect(attributeTargetsInspected).toBe(4_000);

    const addedNodes = Array.from({ length: 5_000 }, () => ({ nodeType: 1, tagName: "DIV" }));
    callback!([{
      type: "childList",
      target: { tagName: "DIV" },
      oldValue: null,
      removedNodes: [],
      addedNodes,
    }]);
    expect(addedNodesInspected).toBe(2_000);
    expect(runInNewContext(
      "[globalThis.__inertiaAgentBrowser.scanLimitReached, globalThis.__inertiaAgentBrowser.evidenceWithheld]",
      context,
    )).toEqual([true, undefined]);
  });
});
