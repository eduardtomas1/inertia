import { useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";

import {
  BACKEND_CREDENTIAL_MASK,
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
  type BackendCredentialState,
} from "@shared/backend-credentials";
import type { AppSettings } from "@shared/contracts";

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

  useEffect(() => {
    let active = true;
    void window.inertia.getBackendCredentialState({
      profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
    }).then((state) => {
      if (active) setWebhookState(state);
    }).catch(() => {
      if (active) setReleaseInfoError("Secure webhook storage is unavailable.");
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
    } catch {
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
    } catch {
      setReleaseInfoError("The Discord webhook could not be removed.");
    } finally {
      setWebhookSaving(false);
    }
  };

  const generateReleaseInfo = async (): Promise<void> => {
    if (releaseInfoLoading) return;
    const normalizedRepositoryUrl = repositoryUrl.trim();
    if (!normalizedRepositoryUrl) {
      setReleaseInfoError("Add a release repository URL before generating.");
      setReleaseInfoStatus(null);
      return;
    }
    setReleaseInfoLoading(true);
    setReleaseInfoError(null);
    setReleaseInfoStatus(null);
    try {
      const storedWebhook = await storeWebhook();
      if (!storedWebhook?.hasSecret) {
        setReleaseInfoError("Add and save a Discord webhook before generating.");
        return;
      }
      const releases = await window.inertia.listInertiaReleases({
        repositoryUrl: normalizedRepositoryUrl,
      });
      const [release, previousRelease] = releases;
      if (!release || !previousRelease) {
        setReleaseInfoError(
          "At least two releases are required to build the comparison.",
        );
        return;
      }
      await window.inertia.sendDiscordReleaseInfo({
        repositoryUrl: normalizedRepositoryUrl,
        previousRelease,
        release,
      });
      setReleaseInfoStatus("Release info sent to Discord.");
    } catch {
      setReleaseInfoError("The release info could not be sent to Discord.");
    } finally {
      setReleaseInfoLoading(false);
    }
  };

  return (
    <section className="settings-card" aria-labelledby="discord-heading">
      <div className="settings-card-heading">
        <div><Bot size={18} /></div>
        <span>
          <h3 id="discord-heading">Discord</h3>
          <p>Prepare release details before publishing them to Discord.</p>
        </span>
      </div>
      <label className="provider-identity-alias">
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
      <label className="provider-identity-alias">
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
          disabled={disabled || webhookSaving || !webhookDraft.trim()}
          onClick={() => { void saveWebhook(); }}
        >
          {webhookSaving ? "Saving..." : "Save webhook"}
        </button>
        <button
          type="button"
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
          <small>Build a bounded local diff summary and send the latest release.</small>
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
    </section>
  );
}
