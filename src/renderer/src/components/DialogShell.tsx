import { X } from "lucide-react";
import { useId, type ComponentPropsWithRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";

import { trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import "./DialogShell.css";

export function DialogHeader({
  title,
  titleId,
  description,
  descriptionId,
  start,
  actions,
  closeLabel,
  closeDisabled,
  closeInert,
  closeRef,
  onClose,
}: {
  title: ReactNode;
  titleId: string;
  description?: ReactNode;
  descriptionId?: string;
  start?: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  closeDisabled?: boolean;
  closeInert?: boolean;
  closeRef?: React.Ref<HTMLButtonElement>;
  onClose?: () => void;
}): React.JSX.Element {
  return (
    <header className="dialog-shell-header">
      {start}
      <div className="dialog-shell-heading">
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
      </div>
      {actions}
      {onClose && closeLabel && (
        <IconButton
          ref={closeRef}
          className="dialog-shell-close"
          label={closeLabel}
          disabled={closeDisabled}
          aria-disabled={closeInert || undefined}
          onClick={() => { if (!closeInert) onClose(); }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      )}
    </header>
  );
}

type DialogShellProps = Omit<ComponentPropsWithRef<"section">, "title" | "onSubmit"> & {
  title: ReactNode;
  titleId: string;
  description?: ReactNode;
  descriptionId?: string;
  headerStart?: ReactNode;
  headerActions?: ReactNode;
  closeLabel?: string;
  closeDisabled?: boolean;
  closeInert?: boolean;
  closeRef?: React.Ref<HTMLButtonElement>;
  onClose?: () => void;
  onDismiss?: () => void;
  footer?: ReactNode;
  footerStart?: ReactNode;
  backdropClassName?: string;
  backdropData?: Record<`data-${string}`, string | boolean | undefined>;
  bodyClassName?: string;
  before?: ReactNode;
  after?: ReactNode;
  trapFocus?: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

export function DialogShell({
  title,
  titleId,
  description,
  descriptionId,
  headerStart,
  headerActions,
  closeLabel,
  closeDisabled,
  closeInert,
  closeRef,
  onClose,
  onDismiss,
  footer,
  footerStart,
  backdropClassName,
  backdropData,
  bodyClassName,
  before,
  after,
  className,
  trapFocus = true,
  onSubmit,
  onKeyDown,
  children,
  ref,
  ...props
}: DialogShellProps): React.JSX.Element {
  const fallbackDescriptionId = useId();
  const describedById = descriptionId ?? fallbackDescriptionId;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (trapFocus) trapModalFocus(event, event.currentTarget);
    onKeyDown?.(event);
  };
  const content = (
    <>
      <DialogHeader
        title={title}
        titleId={titleId}
        description={description}
        descriptionId={describedById}
        start={headerStart}
        actions={headerActions}
        closeLabel={closeLabel}
        closeDisabled={closeDisabled}
        closeInert={closeInert}
        closeRef={closeRef}
        onClose={onClose}
      />
      <div className={clsx("dialog-shell-body", bodyClassName)}>{children}</div>
      {(footer || footerStart) && (
        <footer className="dialog-shell-footer">
          {footerStart && <div className="dialog-shell-footer-start">{footerStart}</div>}
          {footer}
        </footer>
      )}
    </>
  );
  const surface = {
    ...props,
    className: clsx("dialog-shell", className),
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": props["aria-label"] ? undefined : titleId,
    "aria-describedby": props["aria-describedby"] ?? (description ? describedById : undefined),
    onKeyDown: handleKeyDown,
  } as const;
  return (
    <div
      {...backdropData}
      className={clsx("dialog-backdrop", backdropClassName)}
      role="presentation"
      onMouseDown={onDismiss ? (event) => { if (event.target === event.currentTarget) onDismiss(); } : undefined}
    >
      {before}
      {onSubmit
        ? <form {...(surface as ComponentPropsWithRef<"form">)} ref={ref as unknown as React.Ref<HTMLFormElement>} onSubmit={onSubmit}>{content}</form>
        : <section {...surface} ref={ref}>{content}</section>}
      {after}
    </div>
  );
}
