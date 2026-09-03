import { useEffect, useRef, useState } from "react";

const DIALOG_EXIT_MS = 90;

export function DialogPresence({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const lastChildren = useRef<React.ReactNode>(children);

  if (open) lastChildren.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    setClosing((wasClosing) => {
      if (!wasClosing) return true;
      return wasClosing;
    });
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, DIALOG_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted && !open) return null;

  return (
    <div className={closing ? "dialog-presence is-closing" : "dialog-presence"}>
      {open ? children : lastChildren.current}
    </div>
  );
}
