import { useId, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import clsx from "clsx";
import { ChevronDown, type LucideIcon } from "lucide-react";

import type { SettingNotice } from "./useSettingAction";
import "./settings.css";

export function SettingsPage({
  title,
  headingRef,
  className,
  children,
}: {
  title: string;
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={clsx("settings-content", className)}>
      <h2 ref={headingRef} className="settings-page-title" tabIndex={-1}>{title}</h2>
      {children}
    </div>
  );
}

export function SettingsGroup({
  title,
  headingId: requestedHeadingId,
  settingId,
  description,
  icon: Icon,
  notice,
  className,
  children,
}: {
  title: string;
  headingId?: string;
  settingId?: string;
  description?: ReactNode;
  icon?: LucideIcon;
  notice?: SettingNotice | null;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const generatedHeadingId = useId();
  const headingId = requestedHeadingId ?? generatedHeadingId;
  return (
    <section className={clsx("settings-card", className)} aria-labelledby={headingId} data-setting-id={settingId}>
      <div className="settings-card-heading">
        {Icon && <div><Icon size={18} aria-hidden="true" /></div>}
        <span>
          {notice === undefined
            ? <h3 id={headingId}>{title}</h3>
            : <span className="setting-title"><h3 id={headingId}>{title}</h3><SettingStatus notice={notice} /></span>}
          {description && <p>{description}</p>}
        </span>
      </div>
      {children}
    </section>
  );
}

export function SettingStatus({
  notice,
}: {
  notice: SettingNotice | null | undefined;
}): React.JSX.Element {
  return (
    <>
      <span className="setting-status" role="status" aria-live="polite" aria-atomic="true">
        {notice && notice.tone !== "error" ? notice.text : ""}
      </span>
      {notice?.tone === "error" && (
        <span className="setting-status is-error" role="alert">{notice.text}</span>
      )}
    </>
  );
}

export function SettingCopy({
  title,
  titleId,
  description,
  descriptionId,
  notice,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  descriptionId?: string;
  notice?: SettingNotice | null;
}): React.JSX.Element {
  return (
    <span className="setting-copy">
      <span className="setting-title">
        <strong id={titleId}>{title}</strong>
        {notice !== undefined && <SettingStatus notice={notice} />}
      </span>
      {description && <small id={descriptionId}>{description}</small>}
    </span>
  );
}

export function SettingRow({
  id,
  title,
  description,
  notice,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  notice?: SettingNotice | null;
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={clsx("setting-row", className)} data-setting-id={id}>
      <SettingCopy title={title} description={description} notice={notice} />
      {children}
    </div>
  );
}

export function SettingActionRow({
  id,
  title,
  description,
  details,
  notice,
  actions,
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  details?: ReactNode;
  notice?: SettingNotice | null;
  actions?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={clsx("setting-action-row", className)} data-setting-id={id}>
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
        {details}
        {notice !== undefined && <SettingNoteStatus notice={notice} />}
      </span>
      {actions !== undefined && <div>{actions}</div>}
    </div>
  );
}

export function SettingNoteStatus({
  notice,
}: {
  notice: SettingNotice | null;
}): React.JSX.Element {
  return (
    <>
      <small className="setting-note-status" role="status" aria-live="polite" aria-atomic="true">
        {notice && notice.tone !== "error" ? notice.text : ""}
      </small>
      {notice?.tone === "error" && (
        <small className="setting-note-status is-error" role="alert">{notice.text}</small>
      )}
    </>
  );
}

export function SettingDisclosure({
  summary,
  defaultOpen,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const contentId = useId();
  return (
    <details className={clsx("setting-disclosure", className)} open={defaultOpen || undefined}>
      <summary aria-controls={contentId}>
        <ChevronDown size={13} aria-hidden="true" className="setting-disclosure-chevron" />
        {summary}
      </summary>
      <div id={contentId} className="setting-disclosure-content">{children}</div>
    </details>
  );
}

export function useDisclosure(): {
  open: boolean;
  ref: RefObject<HTMLButtonElement | null>;
  toggle: () => void;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return {
    open,
    ref,
    toggle: () => setOpen(!open),
    close: () => {
      setOpen(false);
      ref.current?.focus();
    },
  };
}
