import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import type { SettingsSection } from "../lib/settingsTarget";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { structurallyEqual } from "../utils/structuralEquality";
import { SettingsPage } from "./settings/SettingsLayout";
import { SettingsSectionFallback } from "./settings/SettingsSectionFallback";
import type { SettingsSectionMemory } from "./settings/sectionMemory";
import type { SettingsSectionContext, SettingsViewProps } from "./settings/settingsTypes";
import {
  prefetchSettingsSection,
  settingsSectionDefinition,
  SETTINGS_SECTIONS,
  type SettingsSectionDefinition,
} from "./settingsSections";
import "./SettingsView.css";

type FocusRequest = { anchor?: string };
type PropRecord = Record<string, unknown>;

const IDENTITY_PROPS = new Set(["target"]);
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex=\"-1\"])";

function useStableSettingsProps(props: SettingsViewProps): SettingsViewProps {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const proxies = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const stable = useRef<PropRecord | null>(null);
  const previous = stable.current;
  const next: PropRecord = {};
  let changed = previous === null || Object.keys(previous).length !== Object.keys(props).length;
  for (const [key, value] of Object.entries(props)) {
    let kept: unknown = value;
    if (typeof value === "function") {
      let proxy = proxies.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) => ((latest.current as unknown as PropRecord)[key] as (...args: unknown[]) => unknown)(...args);
        proxies.current.set(key, proxy);
      }
      kept = proxy;
    } else if (previous && key in previous && !IDENTITY_PROPS.has(key) && structurallyEqual(previous[key], value)) {
      kept = previous[key];
    }
    next[key] = kept;
    if (!previous || previous[key] !== kept) changed = true;
  }
  if (changed) stable.current = next;
  return stable.current as unknown as SettingsViewProps;
}

function focusSettingRow(row: HTMLElement): void {
  row.scrollIntoView?.({ block: "center" });
  const control = row.querySelector<HTMLElement>(FOCUSABLE);
  if (control) {
    control.focus();
    return;
  }
  row.tabIndex = -1;
  row.focus();
}

function SettingsSectionHost({
  definition,
  context,
  onReady,
}: {
  definition: SettingsSectionDefinition;
  context: SettingsSectionContext;
  onReady: () => void;
}): React.JSX.Element {
  const Section = useLoadedSurface(definition.load, true);
  useEffect(() => {
    if (Section) onReady();
  });
  return Section
    ? <Section key={definition.instanceKey?.(context)} {...definition.select(context)} />
    : <SettingsSectionFallback />;
}

const SettingsShell = memo(function SettingsShell({
  target = null,
  initialSection = "general",
  onSectionChange,
  ...view
}: SettingsViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [section, setSection] = useState<SettingsSection>(target?.section ?? initialSection);
  const [memory] = useState<SettingsSectionMemory>(() => new Map());
  const focusRequest = useRef<FocusRequest | null>(target?.anchor ? { anchor: target.anchor } : null);
  const previousTarget = useRef(target);
  const focusRootOnMount = useRef(!target?.anchor);
  useEffect(() => {
    if (focusRootOnMount.current) rootRef.current?.focus();
  }, []);
  const resolveFocus = useCallback(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const row = request.anchor
      ? [...rootRef.current?.querySelectorAll<HTMLElement>("[data-setting-id]") ?? []]
        .find((element) => element.dataset.settingId === request.anchor)
      : undefined;
    if (row) focusSettingRow(row);
    else headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!target || target === previousTarget.current) return;
    previousTarget.current = target;
    focusRequest.current = { anchor: target.anchor };
    if (target.section === section) resolveFocus();
    else setSection(target.section);
  }, [resolveFocus, section, target]);
  useEffect(() => {
    onSectionChange?.(section);
  }, [onSectionChange, section]);
  const navigate = useCallback((next: SettingsSection) => {
    if (next === section) return;
    setSection(next);
    focusRequest.current = {};
  }, [section]);
  const regularProjects = useMemo(
    () => view.projects.filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [view.projects],
  );
  const allConversations = useMemo(
    () => [...view.conversations, ...view.archived],
    [view.archived, view.conversations],
  );
  const definition = settingsSectionDefinition(section);
  const context: SettingsSectionContext = {
    ...view,
    target,
    regularProjects,
    allConversations,
    onNavigate: navigate,
    memory,
  };
  return (
    <main ref={rootRef} className="settings-view" aria-label="Settings" tabIndex={-1}>
      <aside className="settings-navigation" aria-label="Settings sections">
        <nav>
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            const prefetch = (): void => prefetchSettingsSection(item);
            return (
              <button
                type="button"
                className={clsx(section === item.id && "is-active")}
                aria-current={section === item.id ? "page" : undefined}
                onFocus={prefetch}
                onPointerDown={prefetch}
                onPointerEnter={prefetch}
                onClick={() => navigate(item.id)}
                key={item.id}
              >
                <Icon size={15} />
                <span>{item.label}</span>
                {item.id === "archive" && view.archived.length > 0 && <small>{view.archived.length}</small>}
              </button>
            );
          })}
        </nav>
      </aside>
      <SettingsPage title={definition.label} headingRef={headingRef} className={definition.contentClassName}>
        <SettingsSectionHost key={definition.id} definition={definition} context={context} onReady={resolveFocus} />
      </SettingsPage>
    </main>
  );
});

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  return <SettingsShell {...useStableSettingsProps(props)} />;
}
