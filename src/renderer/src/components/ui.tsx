import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export function IconButton({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx("icon-button", className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch-control"
      data-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function LoadingMark({ label = "Loading" }: { label?: string }): React.JSX.Element {
  return <span className="loading-mark" role="status" aria-label={label} />;
}
