import type { WebContents } from "electron";

const MAX_AGENT_PAGE_BOUNDARY_ELEMENTS = 4_000;
const MAX_AGENT_PAGE_SHADOW_HOSTS = 2_000;
const MAX_AGENT_PAGE_ATTRIBUTES = 64;
const MAX_AGENT_PAGE_ATTRIBUTE_CHARS = 16_384;
const MAX_AGENT_PAGE_ATTRIBUTE_VALUE_CHARS = 4_096;
const AGENT_PAGE_BOUNDARY_OBJECT_GROUP = "inertia-agent-page-boundary";
const AGENT_PAGE_SHADOW_HOST_BATCH = 16;

interface AgentPageBoundaryState {
  mainFrameId: string | null;
  nestedContentObserved: boolean;
}

const agentPageBoundaryStates = new WeakMap<WebContents, AgentPageBoundaryState>();
const agentPageDebuggerBootstraps = new WeakMap<WebContents, number>();

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function installAgentFileChooserBlock(contents: WebContents): Promise<void> {
  if (contents.debugger.isAttached()) {
    throw new Error("The Browser page is already attached to another debugger.");
  }
  if (!contents.getURL()) {
    await contents.loadURL("about:blank");
    agentPageDebuggerBootstraps.set(contents, contents.navigationHistory.getActiveIndex());
  }
  contents.debugger.attach("1.3");
  const state: AgentPageBoundaryState = {
    mainFrameId: null,
    nestedContentObserved: false,
  };
  agentPageBoundaryStates.set(contents, state);
  contents.debugger.on("message", (_event, method, params) => {
    const payload = objectRecord(params);
    if (method === "Page.frameNavigated") {
      const frame = objectRecord(payload?.frame);
      const id = frame?.id;
      if (typeof id === "string" && typeof frame?.parentId !== "string") {
        state.mainFrameId = id;
        state.nestedContentObserved = false;
      }
      return;
    }
    if (method === "Page.frameAttached") {
      if (typeof payload?.parentFrameId === "string") state.nestedContentObserved = true;
      return;
    }
    if (method === "DOM.shadowRootPushed") {
      const root = objectRecord(payload?.root);
      if (root?.shadowRootType !== "user-agent") state.nestedContentObserved = true;
    }
  });
  try {
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("DOM.enable");
    await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: false,
    });
  } catch (error) {
    try {
      if (contents.debugger.isAttached()) contents.debugger.detach();
    } catch {
      // Preserve the setup failure that made the action unsafe.
    }
    throw error;
  }
}

export function settleAgentPageDebuggerBootstrap(contents: WebContents): void {
  const index = agentPageDebuggerBootstraps.get(contents);
  agentPageDebuggerBootstraps.delete(contents);
  if (index === undefined || index < 0 || index === contents.navigationHistory.getActiveIndex()) return;
  if (contents.navigationHistory.getEntryAtIndex(index)?.url === "about:blank") {
    contents.navigationHistory.removeEntryAtIndex(index);
  }
}

/**
 * Browser evidence has document-start credential ownership only for the
 * top-level document. CDP lifecycle events retain a privileged lifetime taint
 * for frames and shadow roots that appear after DOM.enable. The isolated-world
 * preload independently observes bounded parser mutations, including consumed
 * declarative-shadow templates, before evidence is allowed. Do not use CDP DOM
 * searches or snapshots here: those APIs materialize attacker-sized results.
 */
export function hasUnguardedAgentPageContent(boundaryState: unknown): boolean {
  return objectRecord(boundaryState)?.nestedContentObserved !== false;
}

/**
 * Inspect only bounded, depth-zero host descriptors while the broker has the
 * page frozen. The isolated-world prepass caps DOM traversal and the exact
 * attribute material that a descriptor can return before CDP sees any host.
 * No descendant node, text node, or child attribute is requested.
 */
async function hasPrivilegedAgentPageShadowRoot(
  contents: WebContents,
  frameId: string,
): Promise<boolean | null> {
  const world = objectRecord(await contents.debugger.sendCommand("Page.createIsolatedWorld", {
    frameId,
    worldName: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
    grantUniveralAccess: false,
  }));
  const executionContextId = world?.executionContextId;
  if (typeof executionContextId !== "number" || !Number.isInteger(executionContextId)) return null;

  try {
    const evaluated = objectRecord(await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => { // __inertia_bounded_shadow_hosts__
        const root = document.documentElement;
        const iterator = root && typeof document.createNodeIterator === "function"
          ? document.createNodeIterator(root, 1)
          : null;
        if (!iterator) return null;
        const hostNames = new Set([
          "article", "aside", "blockquote", "body", "div", "footer", "h1", "h2",
          "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span",
        ]);
        const candidates = [];
        let attributeCharacters = 0;
        let elements = 0;
        while (true) {
          const element = iterator.nextNode();
          if (!element) break;
          elements += 1;
          if (elements > ${MAX_AGENT_PAGE_BOUNDARY_ELEMENTS}) return null;
          const attributes = element.attributes;
          if (!attributes || attributes.length > ${MAX_AGENT_PAGE_ATTRIBUTES}) return null;
          for (let index = 0; index < attributes.length; index += 1) {
            const attribute = attributes[index];
            const nameLength = String(attribute?.name ?? "").length;
            const valueLength = String(attribute?.value ?? "").length;
            if (nameLength > ${MAX_AGENT_PAGE_ATTRIBUTE_VALUE_CHARS}
              || valueLength > ${MAX_AGENT_PAGE_ATTRIBUTE_VALUE_CHARS}) return null;
            attributeCharacters += nameLength + valueLength;
            if (attributeCharacters > ${MAX_AGENT_PAGE_ATTRIBUTE_CHARS}) return null;
          }
          if (element.shadowRoot) return null;
          const name = String(element.localName || "").toLowerCase();
          if (hostNames.has(name) || name.includes("-")) {
            candidates.push(element);
            if (candidates.length > ${MAX_AGENT_PAGE_SHADOW_HOSTS}) return null;
          }
        }
        return candidates;
      })()`,
      contextId: executionContextId,
      objectGroup: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
      returnByValue: false,
      generatePreview: false,
      awaitPromise: false,
      userGesture: false,
      timeout: 3_000,
    }));
    const result = objectRecord(evaluated?.result);
    const objectId = result?.objectId;
    if (evaluated?.exceptionDetails || result?.subtype !== "array" || typeof objectId !== "string") {
      return null;
    }

    const properties = objectRecord(await contents.debugger.sendCommand("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false,
    }));
    if (!Array.isArray(properties?.result)) return null;
    const descriptors = new Map<string, Record<string, unknown>>();
    for (const candidate of properties.result) {
      const descriptor = objectRecord(candidate);
      if (!descriptor || typeof descriptor.name !== "string" || descriptors.has(descriptor.name)) {
        return null;
      }
      descriptors.set(descriptor.name, descriptor);
    }
    const lengthValue = objectRecord(descriptors.get("length")?.value)?.value;
    if (typeof lengthValue !== "number"
      || !Number.isInteger(lengthValue)
      || lengthValue < 0
      || lengthValue > MAX_AGENT_PAGE_SHADOW_HOSTS
      || descriptors.size !== lengthValue + 1) return null;

    const hostObjectIds: string[] = [];
    for (let index = 0; index < lengthValue; index += 1) {
      const remote = objectRecord(descriptors.get(String(index))?.value);
      if (remote?.subtype !== "node" || typeof remote.objectId !== "string") return null;
      hostObjectIds.push(remote.objectId);
    }

    let describedAttributeCharacters = 0;
    for (let offset = 0; offset < hostObjectIds.length; offset += AGENT_PAGE_SHADOW_HOST_BATCH) {
      const descriptions = await Promise.all(
        hostObjectIds.slice(offset, offset + AGENT_PAGE_SHADOW_HOST_BATCH).map(
          async (hostObjectId) => objectRecord(await contents.debugger.sendCommand(
            "DOM.describeNode",
            { objectId: hostObjectId, depth: 0, pierce: true },
          )),
        ),
      );
      for (const description of descriptions) {
        const node = objectRecord(description?.node);
        if (node?.nodeType !== 1 || !Array.isArray(node.attributes)) return null;
        if (node.attributes.length > MAX_AGENT_PAGE_ATTRIBUTES * 2
          || node.attributes.length % 2 !== 0) return null;
        for (const part of node.attributes) {
          if (typeof part !== "string" || part.length > MAX_AGENT_PAGE_ATTRIBUTE_VALUE_CHARS) {
            return null;
          }
          describedAttributeCharacters += part.length;
          if (describedAttributeCharacters > MAX_AGENT_PAGE_ATTRIBUTE_CHARS) return null;
        }
        if (!Array.isArray(node.shadowRoots)) {
          if (node.shadowRoots !== undefined) return null;
          continue;
        }
        if (node.shadowRoots.length > 0) return true;
      }
    }
    return false;
  } finally {
    await contents.debugger.sendCommand("Runtime.releaseObjectGroup", {
      objectGroup: AGENT_PAGE_BOUNDARY_OBJECT_GROUP,
    });
  }
}

export async function agentPageHasUnguardedNestedContent(
  contents: WebContents,
): Promise<boolean> {
  const state = agentPageBoundaryStates.get(contents);
  if (state?.nestedContentObserved !== false) return true;
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  const frameId = state.mainFrameId;
  if (typeof frameId !== "string") return true;
  try {
    const hasShadowRoot = await hasPrivilegedAgentPageShadowRoot(contents, frameId);
    if (state.mainFrameId !== frameId) return true;
    if (hasShadowRoot === null) return true;
    if (hasShadowRoot) state.nestedContentObserved = true;
  } catch {
    return true;
  }
  return hasUnguardedAgentPageContent(state);
}

export async function setAgentPageFrozen(
  contents: WebContents,
  frozen: boolean,
): Promise<void> {
  if (!contents.debugger.isAttached()) {
    throw new Error("The Browser security debugger is unavailable.");
  }
  await contents.debugger.sendCommand("Page.setWebLifecycleState", {
    state: frozen ? "frozen" : "active",
  });
}
