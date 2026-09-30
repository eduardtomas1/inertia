import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageEvidencePrivacy,
  agentPageHasSensitiveEvidence,
  installAgentPagePrivacyGuard,
} from "../../src/main/preview-agent-page";

describe("agent Browser privacy classification", () => {
  it("finds a password value wherever it sits in a large document", async () => {
    const text = { tagName: "INPUT", type: "text", value: "plain" };
    const password = { tagName: "INPUT", type: "password", value: "" };
    const state = {
      privacyGuardInstalled: true,
      passwordNodes: new WeakSet(),
      passwordValues: new Set<string>(),
    } as Record<string, unknown>;
    const createNodeIterator = vi.fn();
    const context = {
      __inertiaAgentBrowser: state,
      document: {
        documentElement: {},
        createNodeIterator,
        getElementsByTagName: (name: string): unknown[] => name === "input" ? [text, password] : [],
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
    expect(createNodeIterator).not.toHaveBeenCalled();
    expect(state.evidenceWithheld).toBeUndefined();

    password.value = "beyond-the-element-bound";
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "password" });
    expect([...(state.passwordValues as Set<string>)]).toEqual(["beyond-the-element-bound"]);
  });

  it("withholds evidence when it cannot enumerate every input", async () => {
    const run = async (document: Record<string, unknown>) => {
      const context = {
        __inertiaAgentBrowser: {
          privacyGuardInstalled: true,
          passwordNodes: new WeakSet(),
          passwordValues: new Set<string>(),
        },
        document,
      };
      return await agentPageEvidencePrivacy({
        executeJavaScriptInIsolatedWorld: vi.fn(async (
          _worldId: number,
          scripts: Array<{ code: string }>,
        ) => runInNewContext(scripts[0]!.code, context)),
      } as never);
    };
    const manyInputs = Array.from({ length: 4_001 }, () => ({ tagName: "INPUT", type: "text", value: "" }));
    await expect(run({ documentElement: {}, getElementsByTagName: () => manyInputs }))
      .resolves.toEqual({ withheld: "document-too-large" });

    let nextNodeCalls = 0;
    await expect(run({
      documentElement: {},
      createNodeIterator: () => ({
        nextNode: () => {
          nextNodeCalls += 1;
          return { tagName: "DIV" };
        },
      }),
    })).resolves.toEqual({ withheld: "document-too-large" });
    expect(nextNodeCalls).toBe(4_001);
    await expect(run({
      documentElement: {},
      createNodeIterator: () => ({ nextNode: () => null }),
    })).resolves.toEqual({ withheld: null });
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
    state.evidenceWithheld = "document-too-large";
    await expect(agentPageEvidencePrivacy(contents as never))
      .resolves.toEqual({ withheld: "document-too-large" });
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

  it.each([true, false])("bounds document-start privacy discovery on a dense DOM (inputs enumerable: %s)", async (enumerable) => {
    let nextNodeCalls = 0;
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const context = {
      document: {
        documentElement: {
          nodeType: 1,
          tagName: "HTML",
          getElementsByTagName: enumerable ? (): unknown[] => [] : undefined,
        },
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
      .toBe(enumerable ? undefined : "document-too-large");
  });

  it("classifies a document with more than 4,000 inputs as too large at document start", async () => {
    class MutationObserver {
      constructor(_callback: (records: unknown[]) => void) {}
      observe(): void {}
    }
    const inputs = Array.from({ length: 4_001 }, () => ({ nodeType: 1, tagName: "INPUT", type: "checkbox", value: "on" }));
    const context = {
      document: {
        documentElement: {
          nodeType: 1,
          tagName: "HTML",
          getElementsByTagName: (): unknown[] => inputs,
        },
        addEventListener: vi.fn(),
        createNodeIterator: () => ({ nextNode: () => null }),
      },
      MutationObserver,
    };
    await installAgentPagePrivacyGuard({
      executeJavaScriptInIsolatedWorld: vi.fn(async (
        _worldId: number,
        scripts: Array<{ code: string }>,
      ) => runInNewContext(scripts[0]!.code, context)),
    } as never);
    expect(runInNewContext("globalThis.__inertiaAgentBrowser.evidenceWithheld", context))
      .toBe("document-too-large");
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
    const lateCredential = { tagName: "INPUT", type: "password", value: "" };
    const noInputs = (): unknown[] => [];
    const documentElement = { nodeType: 1, tagName: "HTML", getElementsByTagName: noInputs };
    const context = {
      document: {
        documentElement,
        addEventListener: vi.fn(),
        getElementsByTagName: (): unknown[] => [lateCredential],
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

    const addedNodes = Array.from({ length: 5_000 }, () => ({
      nodeType: 1, tagName: "DIV", getElementsByTagName: noInputs,
    }));
    callback!([{
      type: "childList",
      target: { tagName: "DIV" },
      oldValue: null,
      removedNodes: [],
      addedNodes,
    }]);
    expect(addedNodesInspected).toBe(2_000);
    expect(runInNewContext(
      "[globalThis.__inertiaAgentBrowser.scanLimitReached, globalThis.__inertiaAgentBrowser.evidenceWithheld, globalThis.__inertiaAgentBrowser.passwordValues.size]",
      context,
    )).toEqual([true, undefined, 0]);

    lateCredential.value = "added-after-the-budget";
    callback!([{
      type: "childList",
      target: { tagName: "DIV" },
      oldValue: null,
      removedNodes: [],
      addedNodes,
    }]);
    expect(runInNewContext(
      "[...globalThis.__inertiaAgentBrowser.passwordValues]",
      context,
    )).toEqual(["added-after-the-budget"]);
  });
});
