import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UpdateEverythingRequest } from "../../utils/updateEverythingRun";
import type { UpdateEverythingPlan } from "./updateEverythingPlan";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus } from "../../utils/modalFocus";
import { DialogShell } from "../DialogShell";
import { restartBlockersSentence, runningChatsSentence, updateEverythingLabel } from "./appUpdatePresentation";
import "./UpdateEverythingDialog.css";

const CONTINUE_STORAGE_KEY = "inertia:update-everything:continue";

function readContinueChats(): boolean {
  try {
    return window.localStorage.getItem(CONTINUE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveContinueChats(value: boolean): void {
  try {
    window.localStorage.setItem(CONTINUE_STORAGE_KEY, String(value));
  } catch {
    return;
  }
}

function versionLine(label: string, from: string | null, to: string | null): string {
  if (!to) return `${label} (provider-managed update)`;
  return from ? `${label} ${from} → ${to}` : `${label} ${to}`;
}

export function UpdateEverythingDialog({ plan, onClose, onUpdate, restoreFocus }: {
  plan: UpdateEverythingPlan;
  onClose: () => void;
  onUpdate: (request: UpdateEverythingRequest) => void;
  restoreFocus?: () => void;
}): React.JSX.Element {
  const [continueChats, setContinueChats] = useState(readContinueChats);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const restore = captureModalFocus();
    cancel.current?.focus();
    return restoreFocus ?? restore;
  }, [restoreFocus]);
  const label = updateEverythingLabel(plan.app !== null, plan.providers.map((provider) => provider.label));
  const sentence = runningChatsSentence(plan.runningChats, plan.continuingChats, continueChats);
  const blockers = plan.app ? restartBlockersSentence(plan.workspaceRuns) : null;
  return createPortal(
    <DialogShell className="update-everything-dialog" titleId={titleId} title={`${label}?`}
      closeLabel="Close update" onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      footer={<>
        <button ref={cancel} type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => onUpdate({
          providerIds: plan.providers.map((provider) => provider.providerId),
          includeApp: plan.app !== null,
          continueChats,
        })}>Update</button>
      </>}>
      <ul className="update-everything-items">
        {plan.app && <li>{versionLine("Inertia", plan.app.from, plan.app.to)}</li>}
        {plan.providers.map((provider) => <li key={provider.providerId}>{versionLine(provider.label, provider.from, provider.to)}</li>)}
      </ul>
      {!plan.app && plan.releasePageVersion && <p>Inertia {plan.releasePageVersion} is on the release page; this build cannot update itself.</p>}
      {sentence && <p>{sentence}</p>}
      {blockers && <p>{blockers}</p>}
      {plan.runningChats > 0 && <label className="update-everything-continue">
        <input type="checkbox" checked={continueChats} onChange={(event) => {
          setContinueChats(event.target.checked);
          saveContinueChats(event.target.checked);
        }} />
        <span>Continue chats after the update</span>
      </label>}
    </DialogShell>, document.body,
  );
}
