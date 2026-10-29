import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { SecretRequestListEntry } from "@shared/contracts/client-command/secret-requests";
import type { CommandWithoutId } from "../../../lib/runtimeCommands";
import {
  secretRequestExpiry,
  secretRequestSavedAgo,
  secretRequestStorageLabel,
} from "../../../utils/response-timeline/secretRequests";
import { SettingsGroup, SettingStatus } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";

export const AGENT_SECRETS_INTRO = "Secrets you typed into a chat for an agent. Each sits in a private file that agent's commands can read until it expires. When a system keychain is available, a copy there lets it survive a restart. Revoking deletes both copies. It can't take back a value an agent already used, and Inertia never shows the value again.";
export const AGENT_SECRETS_REFRESH_MS = 60_000;

type ListState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; secrets: SecretRequestListEntry[] };

function listedSecrets(event: ServerEvent): SecretRequestListEntry[] | null {
  return event.type === "request.result" && event.result.kind === "secret-request.list"
    ? event.result.secrets
    : null;
}

export function AgentSecretsSettings({
  disabled,
  request,
  onOpenConversation,
}: {
  disabled: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onOpenConversation?: (conversationId: string) => boolean;
}): React.JSX.Element {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const action = useSettingAction();
  const requestRef = useRef(request);
  requestRef.current = request;
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const secrets = listedSecrets(await requestRef.current({ type: "secret-request.list", payload: {} }));
      setState(secrets ? { status: "ready", secrets } : { status: "failed" });
    } catch {
      setState({ status: "failed" });
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, AGENT_SECRETS_REFRESH_MS);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useLayoutEffect(() => {
    if (!restoreFocus.current || state.status !== "ready") return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (listRef.current?.querySelector<HTMLButtonElement>("button.agent-secret-revoke") ?? emptyRef.current)?.focus();
  }, [state]);

  const revoke = async (secrets: readonly SecretRequestListEntry[]): Promise<void> => {
    if (disabled || action.busy || secrets.length === 0) return;
    restoreFocus.current = true;
    await action.run(async () => {
      for (const secret of secrets) {
        await requestRef.current({ type: "secret-request.revoke", payload: { requestId: secret.requestId } });
      }
    }, {
      key: secrets.length === 1 ? secrets[0]!.requestId : "all",
      exclusive: true,
      success: secrets.length === 1 ? "Secret revoked." : `${secrets.length} secrets revoked.`,
      failure: "The secret could not be revoked.",
    });
    await refresh();
  };

  const secrets = state.status === "ready" ? state.secrets : [];
  return (
    <SettingsGroup
      title="Agent secrets"
      headingId="agent-secrets-heading"
      settingId="agent-secrets"
      description={AGENT_SECRETS_INTRO}
    >
      <div className="agent-secrets">
        {state.status === "loading" && <p className="agent-secrets-empty" role="status">Checking agent secrets…</p>}
        {state.status === "failed" && (
          <p className="agent-secrets-empty" role="status">
            Agent secrets could not be read.
            <button type="button" className="text-button" onClick={() => void refresh()}>Try again</button>
          </p>
        )}
        {state.status === "ready" && secrets.length === 0 && (
          <p ref={emptyRef} className="agent-secrets-empty" tabIndex={-1}>No agent secrets are active.</p>
        )}
        {secrets.length > 0 && (
          <ul ref={listRef} className="archive-list" aria-label="Active agent secrets">
            {secrets.map((secret) => {
              const chatTitle = secret.conversationTitle.trim() || "Untitled chat";
              return (
                <li className="archive-row agent-secret-row" key={secret.requestId}>
                  <span className="setting-copy">
                    <strong title={secret.title}>{secret.title}</strong>
                    <small className="agent-secret-facts">
                      {onOpenConversation
                        ? (
                            <button
                              type="button"
                              className="agent-secret-chat"
                              aria-label={`Open chat ${chatTitle}`}
                              onClick={() => onOpenConversation(secret.conversationId)}
                            >
                              {chatTitle}
                            </button>
                          )
                        : <span>{chatTitle}</span>}
                      <span>{`${secretRequestSavedAgo(secret.answeredAt, now)} · ${secretRequestExpiry(secret.expiresAt, now)}`}</span>
                      <span>{secretRequestStorageLabel(secret.storage)}</span>
                    </small>
                  </span>
                  <button
                    type="button"
                    className="secondary-button agent-secret-revoke"
                    aria-label={`Revoke ${secret.title}`}
                    aria-disabled={disabled || action.busy || undefined}
                    onClick={() => void revoke([secret])}
                  >
                    {action.pending === secret.requestId ? "Revoking…" : "Revoke"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {secrets.length >= 2 && (
          <div className="agent-secrets-footer">
            <button
              type="button"
              className="secondary-button"
              aria-disabled={disabled || action.busy || undefined}
              onClick={() => void revoke(secrets)}
            >
              {action.pending === "all" ? "Revoking…" : "Revoke all"}
            </button>
          </div>
        )}
        {action.notice && (
          <div className="agent-secrets-notice">
            <SettingStatus notice={action.notice} />
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}
