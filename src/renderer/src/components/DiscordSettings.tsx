import { useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";

import {
  BACKEND_CREDENTIAL_MASK,
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
  type BackendCredentialState,
} from "@shared/backend-credentials";
import type { AppSettings } from "@shared/contracts";
import { diagnosticDefinition, type RendererDiagnostic } from "@shared/application-diagnostics";
import { navigateDiagnosticContext } from "../utils/diagnosticNavigation";
import "./DiscordSettings.css";

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
  onUpdate: (settings: Partial<AppSettings>) => void;
}): React.JSX.Element {
  const [releaseInfoLoading, setReleaseInfoLoading] = useState(false);
  const [releaseInfoError, setReleaseInfoError] = useState<string | null>(null);
  const [releaseInfoStatus, setReleaseInfoStatus] = useState<string | null>(null);
  const [webhookDraft, setWebhookDraft] = useState("");
  const [webhookState, setWebhookState] =
    useState<BackendCredentialState | null>(null);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const reportValidation = async (code: RendererDiagnostic["code"]): Promise<void> => {
    try {
      const result = await window.inertia.reportValidationDiagnostic({ code, correlationId: crypto.randomUUID() });
      setIncidentId(result?.incidentId ?? null);
    } catch { /* Inline validation remains usable without diagnostics persistence. */ }
  };

  useEffect(() => {
    let active = true;
    void window.inertia.getBackendCredentialState({
      profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
    }).then((state) => {
      if (active) {
        setWebhookState(state);
        setIncidentId(state.diagnosticId ?? null);
        if (!state.storage.available) setReleaseInfoError("Secure webhook storage is unavailable. No Discord message was sent.");
      }
    }).catch((error: unknown) => {
      if (active) { setReleaseInfoError("Secure webhook storage is unavailable."); setIncidentId(storageIncidentId(error)); }
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

  const saveWebhook = async (): Promise<void> => {
    if (webhookSaving || !webhookDraft.trim()) return;
    setWebhookSaving(true);
    setReleaseInfoError(null);
    setReleaseInfoStatus(null);
    try {
      await storeWebhook();
      setReleaseInfoStatus("Discord webhook saved securely.");
    } catch (error) {
      setIncidentId(storageIncidentId(error));
      setReleaseInfoError("The Discord webhook could not be saved securely.");
    } finally {
      setWebhookSaving(false);
    }
  };

  const clearWebhook = async (): Promise<void> => {
    if (webhookSaving) return;
    setWebhookSaving(true);
    setReleaseInfoError(null);
    setReleaseInfoStatus(null);
    try {
      const state = await window.inertia.clearBackendCredential({
        profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
      });
      setWebhookState(state);
      setWebhookDraft("");
      setReleaseInfoStatus("Discord webhook removed.");
    } catch (error) {
      setIncidentId(storageIncidentId(error));
      setReleaseInfoError("The Discord webhook could not be removed.");
    } finally {
      setWebhookSaving(false);
    }
  };

  const generateReleaseInfo = async (): Promise<void> => {
    if (releaseInfoLoading) return;
    const normalizedRepositoryUrl = repositoryUrl.trim();
    if (!normalizedRepositoryUrl) {
      void reportValidation("discord.repository-missing");
      setReleaseInfoError("Add a release repository URL before generating.");
      setReleaseInfoStatus(null);
      return;
    }
    setReleaseInfoLoading(true);
    setIncidentId(null);
    setReleaseInfoError(null);
    setReleaseInfoStatus(null);
    let deliveryRequested = false;
    try {
      const storedWebhook = await storeWebhook();
      if (!storedWebhook?.hasSecret) {
        void reportValidation("discord.webhook-missing");
        setReleaseInfoError("Add and save a Discord webhook before generating.");
        return;
      }
      deliveryRequested = true;
      const result = await window.inertia.sendDiscordReleaseInfo({
        repositoryUrl: normalizedRepositoryUrl,
      });
      setIncidentId(result.incidentId ?? null);
      if (!result.sent) {
        const explanation = diagnosticDefinition(result.code);
        setReleaseInfoError(`${explanation.title}. ${explanation.nextStep}`);
      } else setReleaseInfoStatus(result.comparisonLimited
        ? "Discord confirmed delivery. The comparison exceeded the preview limit; published release notes and the full comparison link were sent."
        : "Discord confirmed delivery of the release info.");
    } catch (error) {
      setIncidentId(storageIncidentId(error));
      setReleaseInfoError(deliveryRequested
        ? "Delivery could not be confirmed. Check the Discord channel before trying again; the message may have arrived."
        : "Secure webhook storage is unavailable. No Discord message was sent.");
    } finally {
      setReleaseInfoLoading(false);
    }
  };

  return (
    <section className="settings-card discord-settings" aria-labelledby="discord-heading">
      <div className="settings-card-heading">
        <div><Bot size={18} /></div>
        <span>
          <h3 id="discord-heading">Discord</h3>
          <p>Prepare release details before publishing them to Discord.</p>
        </span>
      </div>
      <label className="discord-field">
        <span>
          <strong>Repository URL</strong>
          <small>Public GitHub or GitLab repository used to find releases.</small>
        </span>
        <input
          aria-label="Discord release repository URL"
          disabled={disabled}
          maxLength={500}
          placeholder="https://github.com/org/repo"
          type="url"
          value={repositoryUrl}
          onChange={(event) => {
            void onUpdate({ discordReleaseRepositoryUrl: event.target.value });
          }}
        />
      </label>
      <label className="discord-field">
        <span>
          <strong>Webhook URL</strong>
          <small>
            {webhookState?.hasSecret
              ? "Stored in the operating system credential vault. Paste a value only to replace it."
              : "Incoming Discord webhook stored only in the operating system credential vault."}
          </small>
        </span>
        <input
          aria-label="Discord webhook URL"
          autoComplete="off"
          disabled={disabled || webhookSaving
            || webhookState?.storage.available === false}
          maxLength={500}
          placeholder={webhookState?.hasSecret
            ? BACKEND_CREDENTIAL_MASK
            : "https://discord.com/api/webhooks/..."}
          type="password"
          value={webhookDraft}
          onChange={(event) => setWebhookDraft(event.target.value)}
        />
      </label>
      <div className="settings-inline-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || webhookSaving || !webhookDraft.trim()}
          onClick={() => { void saveWebhook(); }}
        >
          {webhookSaving ? "Saving..." : "Save webhook"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || webhookSaving || !webhookState?.hasSecret}
          onClick={() => { void clearWebhook(); }}
        >
          Remove webhook
        </button>
      </div>
      {webhookState?.storage.available === false && (
        <p className="settings-card-note" role="status">
          {webhookState.storage.message}
        </p>
      )}
      <div className="codex-binary-path runtime-log-setting">
        <span>
          <strong>Release info</strong>
          <small>Send published release notes and a bounded commit preview. No AI request is made.</small>
        </span>
        <div>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || releaseInfoLoading || webhookSaving
              || (!webhookState?.hasSecret && !webhookDraft.trim())}
            onClick={() => { void generateReleaseInfo(); }}
          >
            <RefreshCw size={14} />
            {releaseInfoLoading ? "Sending..." : "Generate"}
          </button>
        </div>
      </div>
      {releaseInfoError && (
        <p className="settings-card-note release-info-status" role="status">
          {releaseInfoError}
        </p>
      )}
      {releaseInfoStatus && (
        <p className="settings-card-note release-info-status" role="status">
          {releaseInfoStatus}
        </p>
      )}
      {incidentId && <button type="button" className="secondary-button discord-diagnostic-link" onClick={() => navigateDiagnosticContext({
        section: "diagnostics", selection: { incidentId },
      })}>View diagnostics</button>}
    </section>
  );
}
