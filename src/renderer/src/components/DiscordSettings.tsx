import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Send } from "lucide-react";

import {
  BACKEND_CREDENTIAL_MASK,
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
  type BackendCredentialState,
} from "@shared/backend-credentials";
import type { AppSettings } from "@shared/contracts";
import { diagnosticDefinition, type RendererDiagnostic } from "@shared/application-diagnostics";
import { isReleaseRepositoryUrl, RELEASE_REPOSITORY_URL_MAX_LENGTH } from "@shared/release-repository";
import { navigateDiagnosticContext } from "../utils/diagnosticNavigation";
import { SettingTextField } from "./settings/SettingControls";
import { SettingActionRow, SettingCopy, SettingNoteStatus, SettingsGroup } from "./settings/SettingsLayout";
import { useSettingAction } from "./settings/useSettingAction";
import "./DiscordSettings.css";

export const DISCORD_REPOSITORY_URL_ERROR = "Use an HTTPS GitHub or GitLab repository URL.";

class DiscordReleaseError extends Error {}

function storageIncidentId(error: unknown): string | null {
  return error instanceof Error ? /\[incident:([0-9a-f-]{36})\]$/u.exec(error.message)?.[1] ?? null : null;
}

export function DiscordSettings({
  disabled,
  repositoryUrl,
  onUpdate,
}: {
  disabled: boolean;
  repositoryUrl: string;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const discord = useSettingAction();
  const [webhookDraft, setWebhookDraft] = useState("");
  const [webhookState, setWebhookState] = useState<BackendCredentialState | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const postTrigger = useRef<HTMLButtonElement>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const restorePostFocus = useRef(false);
  useLayoutEffect(() => {
    if (confirming) {
      confirmCancel.current?.focus();
      return;
    }
    if (!restorePostFocus.current) return;
    restorePostFocus.current = false;
    postTrigger.current?.focus();
  }, [confirming]);
  const reportValidation = async (code: RendererDiagnostic["code"]): Promise<void> => {
    try {
      const result = await window.inertia.reportValidationDiagnostic({ code, correlationId: crypto.randomUUID() });
      setIncidentId(result?.incidentId ?? null);
    } catch {
      setIncidentId(null);
    }
  };

  useEffect(() => {
    let active = true;
    void window.inertia.getBackendCredentialState({
      profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
    }).then((state) => {
      if (active) {
        setWebhookState(state);
        setIncidentId(state.diagnosticId ?? null);
        if (!state.storage.available) setStorageError("Secure webhook storage is unavailable. No Discord message was sent.");
      }
    }).catch((error: unknown) => {
      if (active) {
        setStorageError("Secure webhook storage is unavailable.");
        setIncidentId(storageIncidentId(error));
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const storeWebhook = async (): Promise<BackendCredentialState | null> => {
    const webhookUrl = webhookDraft.trim();
    if (!webhookUrl) return webhookState;
    const state = await window.inertia.setBackendCredential({
      profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
      secret: webhookUrl,
    });
    setWebhookState(state);
    if (!state.storage.available || !state.hasSecret) throw new Error(`Secure webhook storage is unavailable.${state.diagnosticId ? ` [incident:${state.diagnosticId}]` : ""}`);
    setWebhookDraft("");
    return state;
  };

  const failWith = (fallback: string) => (error: unknown): string => {
    setIncidentId(storageIncidentId(error));
    return error instanceof DiscordReleaseError ? error.message : fallback;
  };

  const saveUnavailable = disabled || discord.busy || !webhookDraft.trim();
  const removeUnavailable = disabled || discord.busy || !webhookState?.hasSecret;
  const postUnavailable = disabled || discord.busy || (!webhookState?.hasSecret && !webhookDraft.trim());

  const saveWebhook = (): void => {
    if (saveUnavailable) return;
    setStorageError(null);
    void discord.run(storeWebhook, {
      key: "save",
      exclusive: true,
      success: "Discord webhook saved securely.",
      failure: failWith("The Discord webhook could not be saved securely."),
    });
  };

  const clearWebhook = (): void => {
    if (removeUnavailable) return;
    setStorageError(null);
    void discord.run(async () => {
      const state = await window.inertia.clearBackendCredential({
        profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
      });
      setWebhookState(state);
      setWebhookDraft("");
    }, {
      key: "remove",
      exclusive: true,
      success: "Discord webhook removed.",
      failure: failWith("The Discord webhook could not be removed."),
    });
  };

  const requestPost = (): void => {
    if (postUnavailable) return;
    if (!repositoryUrl.trim()) {
      void reportValidation("discord.repository-missing");
      discord.report({ tone: "error", text: "Add a release repository URL before posting." });
      return;
    }
    discord.report(null);
    setConfirming(true);
  };

  const postReleaseInfo = (): void => {
    const normalizedRepositoryUrl = repositoryUrl.trim();
    restorePostFocus.current = true;
    setConfirming(false);
    setIncidentId(null);
    let deliveryRequested = false;
    void discord.run(async () => {
      const storedWebhook = await storeWebhook();
      if (!storedWebhook?.hasSecret) {
        void reportValidation("discord.webhook-missing");
        throw new DiscordReleaseError("Add and save a Discord webhook before posting.");
      }
      deliveryRequested = true;
      const result = await window.inertia.sendDiscordReleaseInfo({ repositoryUrl: normalizedRepositoryUrl });
      setIncidentId(result.incidentId ?? null);
      if (!result.sent) {
        const explanation = diagnosticDefinition(result.code);
        throw new DiscordReleaseError(`${explanation.title}. ${explanation.nextStep}`);
      }
      return result.comparisonLimited;
    }, {
      key: "send",
      exclusive: true,
      success: (comparisonLimited) => comparisonLimited
        ? "Discord confirmed delivery. The comparison exceeded the preview limit; published release notes and the full comparison link were sent."
        : "Discord confirmed delivery of the release info.",
      failure: (error) => {
        if (error instanceof DiscordReleaseError) return error.message;
        setIncidentId(storageIncidentId(error));
        return deliveryRequested
          ? "Delivery could not be confirmed. Check the Discord channel before trying again; the message may have arrived."
          : "Secure webhook storage is unavailable. No Discord message was sent.";
      },
    });
  };

  const webhookBusy = discord.pending === "save" || discord.pending === "remove";
  return (
    <SettingsGroup
      className="discord-settings"
      title="Discord"
      headingId="discord-heading"
    >
      <SettingTextField
        id="discord-repository"
        layout="stacked"
        className="discord-field"
        title="Repository URL"
        description="Public GitHub or GitLab repository used to find releases."
        label="Discord release repository URL"
        disabled={disabled}
        maxLength={RELEASE_REPOSITORY_URL_MAX_LENGTH}
        placeholder="https://github.com/org/repo"
        type="url"
        value={repositoryUrl}
        validate={(value) => value === "" || isReleaseRepositoryUrl(value) ? null : DISCORD_REPOSITORY_URL_ERROR}
        onSave={(discordReleaseRepositoryUrl) => onUpdate({ discordReleaseRepositoryUrl })}
      />
      <div className="setting-field discord-field" data-setting-id="discord-webhook">
        <SettingCopy
          title="Webhook URL"
          description={webhookState?.hasSecret
            ? "Stored in the operating system credential vault. Paste a new value to replace it."
            : "Incoming Discord webhook, stored only in the operating system credential vault."}
        />
        <span className="discord-webhook-control">
          <input
            className="setting-input"
            aria-label="Discord webhook URL"
            autoComplete="off"
            disabled={disabled || webhookBusy
              || webhookState?.storage.available === false}
            maxLength={500}
            placeholder={webhookState?.hasSecret
              ? BACKEND_CREDENTIAL_MASK
              : "https://discord.com/api/webhooks/…"}
            type="password"
            value={webhookDraft}
            onChange={(event) => setWebhookDraft(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            aria-disabled={saveUnavailable || undefined}
            onClick={saveWebhook}
          >
            {discord.pending === "save" ? "Saving…" : "Save webhook"}
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-disabled={removeUnavailable || undefined}
            onClick={clearWebhook}
          >
            Remove webhook
          </button>
        </span>
      </div>
      {webhookState?.storage.available === false && (
        <p className="discord-note" role="status">
          {webhookState.storage.message}
        </p>
      )}
      <SettingActionRow
        id="discord-release"
        className="runtime-log-setting"
        title="Post release to Discord"
        description="Posts the published release notes and a bounded commit preview to the webhook channel. No AI request is made."
        actions={(
          <button
            ref={postTrigger}
            type="button"
            className="secondary-button"
            aria-expanded={confirming}
            aria-disabled={postUnavailable || undefined}
            onClick={requestPost}
          >
            <Send size={14} aria-hidden="true" />
            {discord.pending === "send" ? "Posting…" : "Post release to Discord…"}
          </button>
        )}
      />
      {confirming && (
        <div
          className="discord-post-confirm"
          role="group"
          aria-label="Confirm Discord post"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            restorePostFocus.current = true;
            setConfirming(false);
          }}
        >
          <strong>Post the latest release to Discord?</strong>
          <small>Everyone in the webhook&apos;s channel will see it. Discord posts cannot be withdrawn from Inertia.</small>
          <div>
            <button ref={confirmCancel} type="button" className="secondary-button" onClick={() => { restorePostFocus.current = true; setConfirming(false); }}>Cancel</button>
            <button type="button" className="primary-button" disabled={disabled || discord.busy} onClick={postReleaseInfo}>Post to Discord</button>
          </div>
        </div>
      )}
      <div className="release-info-status">
        <SettingNoteStatus notice={discord.notice ?? (storageError ? { tone: "info", text: storageError } : null)} />
      </div>
      {incidentId && <button type="button" className="secondary-button discord-diagnostic-link" onClick={() => navigateDiagnosticContext({
        section: "help", anchor: "diagnostics-incidents", selection: { incidentId },
      })}>View diagnostics</button>}
    </SettingsGroup>
  );
}
