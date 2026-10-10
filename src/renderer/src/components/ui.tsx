import { type ComponentPropsWithRef, type ReactNode } from "react";
import clsx from "clsx";

import { TooltipButton } from "./TooltipButton";

export function IconButton({
  label,
  className,
  ...props
}: ComponentPropsWithRef<"button"> & {
  label: string;
  shortcut?: string;
  children: ReactNode;
}): React.JSX.Element {
  return <TooltipButton tooltip={label} describeTooltip={false} aria-label={label} className={clsx("icon-button", className)} {...props} />;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  inactive = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  inactive?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={inactive || undefined}
      className="switch-control"
      data-checked={checked}
      disabled={disabled}
      onClick={() => { if (!inactive) onChange(!checked); }}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function LoadingMark({
  label = "Loading",
  size = 14,
  className,
  "aria-hidden": hidden,
}: {
  label?: string;
  size?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}): React.JSX.Element {
  const decorative = hidden === true || hidden === "true";
  return (
    <svg
      className={clsx("loading-mark", className)}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? "true" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
