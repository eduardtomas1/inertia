import { lazy, Suspense, useContext, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CursorSdkContext } from "./CursorSdkContext";
import "./CursorSdkAccount.css";

const CursorSdkAccount = lazy(async () => ({
  default: (await import("./CursorSdkAccount")).CursorSdkAccount,
}));

export function CursorSdkEntry() {
  const transport = useContext(CursorSdkContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!transport) return null;
  return (
    <section aria-label="Cursor SDK account" className="cursor-sdk-entry">
      <button ref={trigger} type="button" className="cursor-sdk-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} aria-hidden="true" />Cursor SDK
      </button>
      {open && (
        <Suspense fallback={<p role="status" className="cursor-sdk-account">Loading Cursor SDK settings…</p>}>
          <CursorSdkAccount transport={transport} />
          <button type="button" className="text-button cursor-sdk-close" onClick={() => {
            setOpen(false);
            trigger.current?.focus();
          }}>Close SDK settings</button>
        </Suspense>
      )}
    </section>
  );
}
