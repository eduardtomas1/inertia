import { useEffect, useState } from "react";

const DIALOG_EXIT_MS = 90;

export function DialogPresence({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), DIALOG_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  if (!mounted && !open) return null;

  const closing = !open;
  return (
    <div
      className={closing ? "dialog-presence is-closing" : "dialog-presence"}
      aria-hidden={closing ? "true" : undefined}
      inert={closing ? true : undefined}
    >
      {children}
    </div>
  );
}
