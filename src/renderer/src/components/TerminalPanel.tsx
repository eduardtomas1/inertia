import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Columns2, Plus, TerminalSquare, X } from "lucide-react";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import { PaneResizeHandle } from "./PaneResizeHandle";
import {
  appendTerminalTab,
  claimTerminalPanelOwner,
  isCurrentTerminalPanelOwner,
  MAX_PERSISTED_TERMINAL_TABS,
  newTerminalTab,
  persistTerminalTabs,
  readPersistedTerminalTabs,
  replaceTerminalTabWithoutHiding,
  terminalCloseCommand,
  TERMINAL_CLOSE_FAILURE_MESSAGE,
  terminalStorageKey,
  type TerminalPanelProps,
  type TerminalReplacement,
  type TerminalTab,
  useTerminalTabsLifecycle,
} from "./TerminalPanelSupport";
import { TerminalSession } from "./TerminalPanelSession";
import { IconButton } from "./ui";
function ScopedTerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const subscribe = props.subscribe;
  const sendCommand = props.sendCommand;
  const resumeRequestConversationId = props.resumeRequestConversationId;
  const onResumeRequestHandled = props.onResumeRequestHandled;
  const actionRequestId = props.actionId;
  const onActionRequestHandled = props.onActionStarted;
  const storageKey = terminalStorageKey(props.projectId, props.conversationId);
  const [panelOwner] = useState(() => claimTerminalPanelOwner(storageKey));
  const [initialTabs] = useState(() => readPersistedTerminalTabs(storageKey));
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabs);
  const [activeId, setActiveId] = useState(initialTabs[0].id);
  const [split, setSplit] = useState(false);
  const [persistedSplitPercent, setPersistedSplitPercent] = usePersistedSize("inertia:layout:terminal-split-percent:v1", 50, { min: 25, max: 75 });
  const [splitPercent, setSplitPercent] = useState(persistedSplitPercent);
  const [splitOrientation, setSplitOrientation] = useState<"horizontal" | "vertical">("vertical");
  const [resumedTerminals, setResumedTerminals] = useState<ReadonlyMap<string, {
    tabId: string;
    terminalId: string;
  }>>(() => new Map());
  const [closingTabIds, setClosingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionRoutingError, setActionRoutingError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<readonly [string, string] | null>(null);
  const mountedRef = useRef(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const tabsRef = useTerminalTabsLifecycle(storageKey, tabs, sendCommand);
  const handledPanelResumeRequestRef = useRef<string | null>(null);
  const handledBlockedActionRef = useRef<string | null>(null);
  const [pendingTerminalCloses] = useState(
    () => new Map<string, Map<string, boolean>>(),
  );
  const reconcilePendingTerminalExitRef = useRef<(terminalId: string) => void>(
    () => undefined,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => setSplitPercent(persistedSplitPercent), [persistedSplitPercent]);

  useEffect(() => setResumedTerminals(new Map()), [
    props.conversationId,
    props.projectId,
    props.status,
  ]);

  useEffect(() => subscribe((event) => {
    if (event.type !== "terminal.exit") return;
    reconcilePendingTerminalExitRef.current(event.terminalId);
    setResumedTerminals((current) => {
      const next = new Map(current);
      for (const [conversationId, resumed] of next) {
        if (resumed.terminalId === event.terminalId) {
          next.delete(conversationId);
        }
      }
      return next.size === current.size ? current : next;
    });
  }), [subscribe]);

  const resumedTabIds = useMemo(() => new Set(
    [...resumedTerminals.values()].map(({ tabId }) => tabId),
  ), [resumedTerminals]);
  const actionTargetId = !props.actionId || !resumedTabIds.has(activeId)
    ? activeId
    : (tabs.find(({ id }) => !resumedTabIds.has(id))?.id ?? null);

  useEffect(() => {
    const actionId = actionRequestId;
    if (!actionId) {
      handledBlockedActionRef.current = null;
      setActionRoutingError(null);
      return;
    }
    if (actionTargetId) {
      setActionRoutingError(null);
      if (actionTargetId !== activeId) setActiveId(actionTargetId);
      return;
    }
    if (tabs.length < MAX_PERSISTED_TERMINAL_TABS) {
      setTabs((current) => appendTerminalTab(current, setActiveId));
      return;
    }
    const identity = `${storageKey}:${actionId}`;
    setActionRoutingError(
      "End a resumed provider terminal before starting this project action.",
    );
    if (handledBlockedActionRef.current !== identity) {
      handledBlockedActionRef.current = identity;
      onActionRequestHandled?.();
    }
  }, [
    actionTargetId,
    activeId,
    actionRequestId,
    onActionRequestHandled,
    storageKey,
    tabs.length,
  ]);

  useEffect(() => {
    if (!props.visible || tabs.length > 0) return;
    const tab = newTerminalTab();
    setTabs([tab]);
    setActiveId(tab.id);
  }, [props.visible, tabs.length]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSplitOrientation(width < 430 && height >= 280 ? "horizontal" : "vertical");
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const addTerminal = (): void => {
    setTabs((current) => appendTerminalTab(current, setActiveId));
  };

  useEffect(() => {
    const requestedConversationId = resumeRequestConversationId;
    if (!requestedConversationId) {
      handledPanelResumeRequestRef.current = null;
      return;
    }
    if (handledPanelResumeRequestRef.current === requestedConversationId) return;
    const existing = resumedTerminals.get(requestedConversationId);
    if (existing && tabs.some(({ id }) => id === existing.tabId)) {
      handledPanelResumeRequestRef.current = requestedConversationId;
      setActiveId(existing.tabId);
      onResumeRequestHandled?.();
      return;
    }
    if (!resumedTabIds.has(activeId)) return;
    const idleTab = tabs.find(({ id }) => !resumedTabIds.has(id));
    if (idleTab) {
      setActiveId(idleTab.id);
      return;
    }
    if (tabs.length >= MAX_PERSISTED_TERMINAL_TABS) return;

    // A resumed provider owns its terminal until that process exits. Preserve
    // it and give the explicit composer request a fresh terminal to start in.
    setTabs((current) => appendTerminalTab(current, setActiveId));
  }, [
    activeId,
    onResumeRequestHandled,
    resumeRequestConversationId,
    resumedTerminals,
    resumedTabIds,
    tabs,
  ]);

  const setTabClosing = (id: string, closing: boolean): void => {
    setClosingTabIds((closingIds) => {
      const updated = new Set(closingIds);
      if (closing) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  };
  const ownsTerminalPanel = (): boolean => (
    isCurrentTerminalPanelOwner(storageKey, panelOwner)
  );
  const commitTerminalTabs = (next: TerminalTab[]): void => {
    tabsRef.current = next;
    persistTerminalTabs(storageKey, next);
    if (mountedRef.current) setTabs(next);
  };
  const clearCloseError = (id: string): void => {
    setCloseError((current) => current?.[0] === id ? null : current);
  };

  const finishTerminalClose = (id: string): void => {
    if (!ownsTerminalPanel()) return;
    pendingTerminalCloses.delete(id);
    const current = tabsRef.current;
    const next = current.filter((tab) => tab.id !== id);
    if (next.length === current.length) return;
    commitTerminalTabs(next);
    if (!mountedRef.current) return;
    setTabClosing(id, false);
    clearCloseError(id);
    setActiveId((selected) => selected === id
      ? (next.at(-1)?.id ?? "")
      : selected);
    if (next.length < 2) setSplit(false);
    if (next.length === 0) props.onClose();
  };

  const requestTerminalClose = (id: string, terminalId: string): void => {
    const pending = pendingTerminalCloses.get(id);
    if (!pending || pending.get(terminalId)) return;
    pending.set(terminalId, true);
    void sendCommand(terminalCloseCommand(terminalId)).then(() => {
      if (
        !ownsTerminalPanel()
        || pendingTerminalCloses.get(id) !== pending
      ) return;
      pending.delete(terminalId);
      if (!pending.size) finishTerminalClose(id);
    }, (error: unknown) => {
      if (
        !ownsTerminalPanel()
        || pendingTerminalCloses.get(id) !== pending
      ) return;
      if (!pending.has(terminalId)) return;
      pending.set(terminalId, false);
      if (runtimeCommandDelivery(error) === "ambiguous") return;
      if (!mountedRef.current) return;
      setTabClosing(id, false);
      setCloseError([
        id,
        error instanceof Error ? error.message : TERMINAL_CLOSE_FAILURE_MESSAGE,
      ]);
    });
  };

  const requestPendingTerminalCloses = (
    id: string,
    pending: ReadonlyMap<string, boolean>,
  ): void => {
    for (const terminalId of pending.keys()) requestTerminalClose(id, terminalId);
  };
  reconcilePendingTerminalExitRef.current = (terminalId) => {
    for (const [tabId, pending] of pendingTerminalCloses) {
      if (!pending.delete(terminalId)) continue;
      if (!pending.size) finishTerminalClose(tabId);
      else requestPendingTerminalCloses(tabId, pending);
    }
  };

  const closeTerminal = (id: string): void => {
    const closing = tabsRef.current.find((tab) => tab.id === id);
    if (!closing) return;
    const pending = pendingTerminalCloses.get(id);
    if (pending) {
      clearCloseError(id);
      setTabClosing(id, true);
      requestPendingTerminalCloses(id, pending);
      return;
    }
    if (!closing.terminalId) {
      finishTerminalClose(id);
      return;
    }
    clearCloseError(id);
    pendingTerminalCloses.set(id, new Map([[closing.terminalId, false]]));
    setTabClosing(id, true);
    requestTerminalClose(id, closing.terminalId);
  };

  const replaceTerminalTab = (
    tabId: string,
    replacement: TerminalReplacement,
  ): boolean => {
    const pendingClose = pendingTerminalCloses.get(tabId);
    if (pendingClose?.has(replacement.terminalId)) return true;
    if (
      pendingClose
      && pendingClose.size >= MAX_PERSISTED_TERMINAL_TABS
      && (
        replacement.preservePrevious
        || !pendingClose.has(replacement.previousTerminalId)
      )
    ) return false;
    const next = replaceTerminalTabWithoutHiding(
      tabsRef.current,
      tabId,
      replacement.previousTerminalId,
      replacement.terminalId,
      pendingClose ? false : replacement.preservePrevious,
    );
    if (!next) return false;
    commitTerminalTabs(next);
    if (pendingClose) {
      if (!replacement.preservePrevious) pendingClose.delete(replacement.previousTerminalId);
      pendingClose.set(replacement.terminalId, false);
      requestPendingTerminalCloses(tabId, pendingClose);
    }
    return true;
  };

  const updateRestorableTerminal = (
    tabId: string,
    terminalId: string | null,
  ): boolean => {
    if (!ownsTerminalPanel()) return false;
    const pendingClose = pendingTerminalCloses.get(tabId);
    if (pendingClose) {
      if (terminalId === null) pendingClose.delete(
        tabsRef.current.find(({ id }) => id === tabId)?.terminalId ?? "",
      );
      else if (!pendingClose.has(terminalId)) pendingClose.set(terminalId, false);
      if (!pendingClose.size) finishTerminalClose(tabId);
      else requestPendingTerminalCloses(tabId, pendingClose);
      return true;
    }
    let found = false;
    let changed = false;
    const next = tabsRef.current.map((candidate) => {
      if (candidate.id !== tabId) {
        return candidate;
      }
      found = true;
      if (candidate.terminalId === terminalId) return candidate;
      changed = true;
      return { ...candidate, terminalId };
    });
    if (!found) return false;
    if (!changed) return true;
    // A terminal.create response may arrive after this scoped panel unmounts.
    // Persist the exact returned capability synchronously so a later visit can
    // reattach it instead of cancelling a possibly fork-tainted macOS shell.
    commitTerminalTabs(next);
    return true;
  };

  const splitTerminal = () => {
    if (tabs.length < 2) addTerminal();
    setSplit((current) => !current);
  };

  const secondaryId = tabs.find((tab) => tab.id !== activeId)?.id ?? null;
  const sessionIds = new Map(tabs.map((tab) => [tab.id, `terminal-session-${tab.id}`]));
  const gridStyle = { "--terminal-split-percent": `${splitPercent}%` } as CSSProperties;
  const panelError = actionRoutingError ?? closeError?.[1];

  return (
    <aside className="terminal-tabs-panel" aria-label="Terminal panel" hidden={!props.visible}>
      <header className="terminal-tabbar">
        <div className="terminal-tablist" role="tablist" aria-label="Terminals">
          {tabs.map((tab) => <div className={tab.id === activeId ? "terminal-tab is-active" : "terminal-tab"} key={tab.id}><button type="button" id={`terminal-tab-${tab.id}`} role="tab" aria-selected={tab.id === activeId} aria-controls={sessionIds.get(tab.id)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={13} /><span>{tab.label}</span></button><button type="button" aria-label={`Close ${tab.label}`} disabled={closingTabIds.has(tab.id)} onClick={() => closeTerminal(tab.id)}><X size={11} /></button></div>)}
        </div>
        <div className="terminal-tab-actions"><IconButton label={tabs.length >= MAX_PERSISTED_TERMINAL_TABS ? "Maximum of 4 terminals open" : "New terminal"} disabled={tabs.length >= MAX_PERSISTED_TERMINAL_TABS} onClick={addTerminal}><Plus size={14} /></IconButton><IconButton label="Split terminals" aria-pressed={split} onClick={splitTerminal}><Columns2 size={14} /></IconButton></div>
      </header>
      {panelError && (
        <div className="terminal-resume-status is-unavailable" role="alert">
          {panelError}
        </div>
      )}
      <div
        ref={gridRef}
        className={split ? `terminal-session-grid is-split is-${splitOrientation}` : "terminal-session-grid"}
        style={gridStyle}
      >
        {tabs.map((tab) => {
          const visible = tab.id === activeId || (split && tab.id === secondaryId);
          const placement = tab.id === activeId ? "is-primary" : tab.id === secondaryId ? "is-secondary" : "";
          const siblingResumedConversationIds = new Set(
            [...resumedTerminals].flatMap(([conversationId, resumed]) => (
              resumed.tabId === tab.id ? [] : [conversationId]
            )),
          );
          return <div id={sessionIds.get(tab.id)} role="tabpanel" aria-labelledby={`terminal-tab-${tab.id}`} className={`terminal-session-slot ${placement}`} hidden={!visible} key={tab.id}><TerminalSession {...props} initialTerminalId={tab.terminalId} visible={Boolean(props.visible && visible)} actionId={tab.id === actionTargetId ? props.actionId : null} onActionStarted={tab.id === actionTargetId ? props.onActionStarted : undefined} resumeRequestConversationId={tab.id === activeId ? props.resumeRequestConversationId : null} onResumeRequestHandled={tab.id === activeId ? props.onResumeRequestHandled : undefined} siblingResumedConversationIds={siblingResumedConversationIds} onRestorableTerminalChange={(terminalId) => updateRestorableTerminal(tab.id, terminalId)} onTerminalReplaced={(replacement) => replaceTerminalTab(tab.id, replacement)} onProviderResumeStarted={(terminalId, resumedConversationId) => setResumedTerminals((current) => new Map(current).set(resumedConversationId, { tabId: tab.id, terminalId }))} onClose={() => closeTerminal(tab.id)} /></div>;
        })}
        {split && secondaryId && (
          <PaneResizeHandle
            label="Resize split terminals"
            controls={`${sessionIds.get(activeId)} ${sessionIds.get(secondaryId)}`}
            containerRef={gridRef}
            orientation={splitOrientation}
            unit="percent"
            value={splitPercent}
            min={25}
            max={75}
            defaultValue={50}
            onChange={setSplitPercent}
            onCommit={setPersistedSplitPercent}
            valueText={(value) => `${value}% for the active terminal`}
            className="terminal-split-handle"
          />
        )}
      </div>
    </aside>
  );
}

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const scope = `${props.projectId}:${props.conversationId ?? "project"}`;
  return <ScopedTerminalPanel key={scope} {...props} />;
}
