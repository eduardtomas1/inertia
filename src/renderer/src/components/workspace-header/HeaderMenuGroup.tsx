import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function HeaderMenuGroup({
  label,
  icon,
  children,
  disabled = false,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="header-menu-item header-menu-group-trigger"
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={groupId}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) setExpanded((current) => !current);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowRight" && !expanded) {
            event.preventDefault();
            setExpanded(true);
          } else if (event.key === "ArrowLeft" && expanded) {
            event.preventDefault();
            setExpanded(false);
          }
        }}
      >
        {icon}
        <span>{label}</span>
        <ChevronRight size={13} aria-hidden="true" className="header-menu-group-chevron" />
      </button>
      {expanded && (
        <div id={groupId} className="header-menu-group" role="group" aria-label={label}>
          {children}
        </div>
      )}
    </>
  );
}
