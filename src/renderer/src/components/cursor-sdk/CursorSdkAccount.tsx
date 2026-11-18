import type { CursorSdkTransport } from "./CursorSdkContext";
import { useCursorSdkAccount } from "./useCursorSdkAccount";
import "./CursorSdkAccount.css";

const messages = {
  starting: "Starting Cursor SDK sign-in…",
  waiting: "Continue sign-in in your browser.",
  cancelling: "Cancelling sign-in…",
  cancelled: "Sign-in cancelled.",
  expired: "Sign-in expired. Check availability to try again.",
  failed: "Sign-in failed. Check availability to try again.",
  authenticated: "Sign-in completed. Checking SDK availability…",
};

export function CursorSdkAccount({ transport }: { transport: CursorSdkTransport }) {
  const account = useCursorSdkAccount(transport);
  const active = account.login !== null
    && ["starting", "waiting", "cancelling"].includes(account.login.status);
  return (
    <div className="cursor-sdk-account">
      <p>Use the official Cursor SDK for a model you explicitly choose in the model chooser.</p>
      <div role="status" aria-live="polite">
        {account.checking ? "Checking Cursor SDK…" : account.evidence
          ? account.evidence.available ? "Cursor SDK is available." : "Cursor SDK is unavailable in this installation."
          : account.login ? messages[account.login.status] : "Check availability before signing in."}
      </div>
      {account.evidence && (
        <p>{account.evidence.hasCredential
          ? "A credential is saved on this device. Its remote validity has not been checked."
          : "No SDK credential is saved on this device."}</p>
      )}
      {account.error && <p role="alert">{account.error}</p>}
      <div className="cursor-sdk-actions">
        {active ? (
          <>
            {account.login?.status === "waiting" && (
              <button type="button" className="secondary-button" onClick={() => void account.openBrowser()}>Open Cursor sign-in</button>
            )}
            <button type="button" className="secondary-button" onClick={account.cancel}>Cancel sign-in</button>
          </>
        ) : (
          <>
            <button type="button" className="secondary-button" disabled={!account.online || account.checking} onClick={() => void account.check()}>Check Cursor SDK</button>
            <button type="button" className="secondary-button" disabled={!account.online || !account.evidence?.available || account.checking} onClick={account.start}>Sign in with Cursor SDK</button>
          </>
        )}
      </div>
    </div>
  );
}
