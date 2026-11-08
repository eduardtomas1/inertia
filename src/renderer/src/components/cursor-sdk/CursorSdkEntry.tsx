import { lazy, Suspense, useContext, useRef, useState } from "react";
import { CursorSdkContext } from "./CursorSdkContext";

const CursorSdkAccount = lazy(async () => ({
  default: (await import("./CursorSdkAccount")).CursorSdkAccount,
}));

export function CursorSdkEntry() {
  const transport = useContext(CursorSdkContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!transport) return null;
  return (
    <section aria-label="Cursor SDK account" className="backend-account-row">
      <div>
        <button ref={trigger} type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>Cursor SDK</button>
        {open && (
          <Suspense fallback={<p role="status">Loading Cursor SDK settings…</p>}>
            <CursorSdkAccount transport={transport} />
            <button type="button" className="text-button" onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}>Close SDK settings</button>
          </Suspense>
        )}
      </div>
    </section>
  );
}
