import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, QrCode, RadioTower, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { toString as createQrSvg } from "qrcode";

import type { Conversation, Project } from "@shared/contracts";
import type { RemoteConversationGrant } from "@shared/remote-grants";
import type {
  RemoteAccessState,
  RemoteDeviceView,
  RemoteSetupMode,
  RemoteScope,
} from "@shared/remote-protocol";
import { createRemotePairingLink } from "@shared/remote-pairing-link";
import { useRemoteAccessState } from "../hooks/useRemoteAccessState";
import { writeClipboardText } from "../utils/clipboard";
import {
  ConversationGrantEditor,
  DeviceAccessPreview,
  remoteGrantsAllowSomething,
} from "./RemoteConversationGrants";
import { Switch } from "./ui";

const MAX_PROMPT_EXPIRY_DAYS = 7;

function useInvitationCountdown(expiresAt: string | null): {
  expired: boolean;
  label: string;
} {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [expiresAt]);
  const remaining = Math.max(0, (expiresAt ? Date.parse(expiresAt) : 0) - now);
  const totalSeconds = Math.ceil(remaining / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    expired: expiresAt !== null && remaining <= 0,
    label: `${minutes}:${seconds.toString().padStart(2, "0")}`,
  };
}

export function RemoteAccessSettings({
  projects,
  conversations,
}: {
  projects: Project[];
  conversations: Conversation[];
}): React.JSX.Element {
  const remoteLoad = useRemoteAccessState();
  const liveState = remoteLoad.status === "ready" ? remoteLoad.state : null;
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [companionUrl, setCompanionUrl] = useState("");
  const [setupMode, setSetupMode] = useState<RemoteSetupMode>(
    "local-development",
  );
  const [qrSource, setQrSource] = useState<string | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [grants, setGrants] = useState<RemoteConversationGrant[]>([]);
  const [grantDays, setGrantDays] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const setupInitializedRef = useRef(false);
  const current = liveState ?? state;
  const selectedGrants = useMemo(() => {
    const selectedProjects = new Set(projectIds);
    return grants.filter(({ projectId }) => selectedProjects.has(projectId));
  }, [grants, projectIds]);

  useEffect(() => {
    if (!liveState) return;
    setState(liveState);
    if (!setupInitializedRef.current) {
      setupInitializedRef.current = true;
      setRelayUrl(liveState.relayUrl);
      setCompanionUrl(liveState.companionUrl);
      setSetupMode(liveState.setupMode);
    }
  }, [liveState]);

  const invitationLink = useMemo(() => {
    if (!current?.invitation) return null;
    try {
      return createRemotePairingLink(companionUrl, current.invitation);
    } catch {
      return null;
    }
  }, [companionUrl, current?.invitation]);
  const invitationCountdown = useInvitationCountdown(
    current?.invitation?.expiresAt ?? null,
  );
  useEffect(() => {
    let active = true;
    setQrSource(null);
    if (!invitationLink) return () => {
      active = false;
    };
    void createQrSvg(invitationLink, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 208,
      color: { dark: "#111813ff", light: "#ffffffff" },
    }).then((svg) => {
      if (active) setQrSource(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [invitationLink]);

  const pendingPairingIds = current?.pendingPairings
    .map(({ requestId }) => requestId)
    .join(",") ?? "";
  useLayoutEffect(() => {
    setProjectIds([]);
    setGrants([]);
    setPrompting(false);
  }, [pendingPairingIds]);

  const mutate = async (
    operation: () => Promise<RemoteAccessState>,
    success: string,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const next = await operation();
      setState(next);
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Remote Companion could not be updated.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!current) {
    if (remoteLoad.status === "error") {
      return (
        <div className="settings-empty-state" role="alert">
          <p>{remoteLoad.error}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={remoteLoad.retry}
          >
            Retry
          </button>
        </div>
      );
    }
    return <div className="settings-empty-state">Loading Remote Companion…</div>;
  }

  const setupMatches = current.diagnostics.status === "passed"
    && current.relayUrl === relayUrl
    && current.companionUrl === companionUrl
    && current.setupMode === setupMode;

  return (
    <>
      <section className="settings-card" aria-labelledby="remote-heading">
        <div className="settings-card-heading">
          <div><RadioTower size={18} /></div>
          <span>
            <h3 id="remote-heading">Remote Companion</h3>
            <p>View safe conversation projections from a paired browser. The desktop stays authoritative and makes only outbound connections.</p>
          </span>
        </div>
        {!current.available ? (
          <p className="settings-card-note" role="status">
            {current.connectionMessage ?? "Secure platform storage is unavailable, so Remote Companion cannot be enabled."}
          </p>
        ) : (
          <>
            <fieldset className="remote-project-scope" disabled={busy || current.enabled}>
              <legend>1. Choose a setup path</legend>
              <label className="remote-checkbox">
                <input
                  type="radio"
                  name="remote-setup-mode"
                  checked={setupMode === "local-development"}
                  onChange={() => setSetupMode("local-development")}
                />
                <span><strong>Local development</strong><br /><small>One computer, loopback HTTP and WS, no phone access.</small></span>
              </label>
              <label className="remote-checkbox">
                <input
                  type="radio"
                  name="remote-setup-mode"
                  checked={setupMode === "self-hosted"}
                  onChange={() => setSetupMode("self-hosted")}
                />
                <span><strong>Self-hosted / private network</strong><br /><small>Use matching checksummed artifacts behind HTTPS and WSS. A Tailscale-only hostname is the simplest cross-device path.</small></span>
              </label>
            </fieldset>
            <label className="remote-relay-setting">
              <span>2. Companion HTTPS URL</span>
              <input
                value={companionUrl}
                maxLength={2_048}
                disabled={busy || current.enabled}
                placeholder={setupMode === "self-hosted"
                  ? "https://companion.your-tailnet.ts.net/"
                  : "http://127.0.0.1:4173/"}
                onChange={(event) => setCompanionUrl(event.target.value)}
              />
              <small>Invitation data is added only after # in the client fragment; it is never sent to this server.</small>
            </label>
            <label className="remote-relay-setting">
              <span>Relay WebSocket URL</span>
              <input
                value={relayUrl}
                maxLength={2_048}
                disabled={busy || current.enabled}
                placeholder={setupMode === "self-hosted"
                  ? "wss://companion.your-tailnet.ts.net/remote"
                  : "ws://127.0.0.1:8787/remote"}
                onChange={(event) => setRelayUrl(event.target.value)}
              />
              <small>Use WSS outside loopback. The relay routes ciphertext and cannot read invitations, grants, or session content.</small>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || current.enabled || !relayUrl || !companionUrl}
              onClick={() => {
                void mutate(
                  () => window.inertia.setRemoteAccessEnabled({
                    enabled: false,
                    relayUrl,
                    companionUrl,
                    setupMode,
                    testOnly: true,
                  }),
                  "Setup test passed. You can enable Remote Companion.",
                );
              }}
            >
              <ShieldCheck size={14} />Test setup
            </button>
            <p className="settings-card-note" role="status">
              Test: {current.diagnostics.status}
              {current.diagnostics.message ? ` · ${current.diagnostics.message}` : ""}
            </p>
            {current.diagnostics.failureClass === "endpoint-authentication" && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  void mutate(
                    () => window.inertia.setRemoteAccessEnabled({
                      enabled: false,
                      relayUrl,
                      companionUrl,
                      setupMode,
                      testOnly: true,
                      resetEndpoint: true,
                    }),
                    "Endpoint reset and setup re-tested. Forget the old profile in every browser, then pair again.",
                  );
                }}
              >
                Reset endpoint and re-test
              </button>
            )}
            <div className="setting-row">
              <span className="setting-row-icon"><ShieldCheck size={17} /></span>
              <span className="setting-copy">
                <strong>3. Allow remote access</strong>
                <small>Off by default. Test this exact setup first. Disabling closes every session immediately.</small>
              </span>
              <Switch
                label="Allow remote access"
                checked={current.enabled}
                disabled={busy || (!current.enabled && !setupMatches)}
                onChange={(enabled) => {
                  void mutate(
                    () => window.inertia.setRemoteAccessEnabled({
                      enabled,
                      relayUrl,
                      companionUrl,
                      setupMode,
                    }),
                    enabled ? "Remote Companion enabled." : "Remote Companion disabled.",
                  );
                }}
              />
            </div>
            <p className="settings-card-note">
              Supervised mode means a remote text prompt can start only within the exact conversations you grant. Approvals, secrets, files, terminals, Git, Full Access, provider settings, and diagnostics remain desktop-only.
            </p>
            <p className="settings-card-note">
              Inertia does not bundle or start the reference relay or companion browser. Install the matching versioned artifacts described in the self-hosting guide.
            </p>
            <p className="settings-card-note">
              Status: {current.connection}
              {current.connectionMessage ? ` · ${current.connectionMessage}` : ""}
              {current.activeSessions > 0 ? ` · ${current.activeSessions} active browser session${current.activeSessions === 1 ? "" : "s"}` : ""}
            </p>
            <details>
              <summary>Safe connection diagnostics</summary>
              <p className="settings-card-note">
                Transport {current.diagnostics.transport ?? "unknown"} · TLS {current.diagnostics.tls ?? "unknown"} · origin {current.diagnostics.originPolicy} · endpoint {current.diagnostics.endpointOwnership}
              </p>
              <p className="settings-card-note">
                Versions: desktop {current.diagnostics.desktopVersion} · browser {current.diagnostics.browserVersion ?? "unknown"} · relay {current.diagnostics.relayVersion ?? "unknown"} · protocols {current.diagnostics.relayProtocol ?? "?"}/{current.diagnostics.remoteProtocol ?? "?"}
              </p>
              <p className="settings-card-note">
                Endpoint epoch {current.diagnostics.endpointEpoch ?? "unclaimed"} · last connected {current.diagnostics.lastConnectedAt ? new Date(current.diagnostics.lastConnectedAt).toLocaleString() : "never"} · retry {current.diagnostics.retryClass} · failure {current.diagnostics.failureClass}
              </p>
            </details>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !current.enabled || current.connection !== "online"}
              onClick={() => {
                void mutate(
                  async () => {
                    await window.inertia.createRemotePairingInvitation();
                    return await window.inertia.getRemoteAccessState();
                  },
                  "Invitation created. It expires in five minutes.",
                );
              }}
            >
              {current.devices.length === 0 ? "Create pairing invitation" : "Pair another browser"}
            </button>
          </>
        )}
        {status && <p className="settings-card-note" role="status">{status}</p>}
      </section>

      {current.invitation && (
        <section className="settings-card" aria-labelledby="remote-invitation-heading">
          <div className="settings-card-heading">
            <div><QrCode size={18} /></div>
            <span>
              <h3 id="remote-invitation-heading">Short-lived invitation</h3>
              <p>Scan on the browser you are pairing. The relay cannot read or use this invitation.</p>
            </span>
          </div>
          {qrSource && invitationLink && (
            <img
              src={qrSource}
              width={208}
              height={208}
              alt="QR code containing the short-lived Remote Companion pairing link"
              style={{ display: "block", maxWidth: "100%", margin: "12px auto" }}
            />
          )}
          <p className="settings-card-note" role="timer">
            {invitationCountdown.expired
              ? "Expired — regenerate the invitation."
              : `Expires in ${invitationCountdown.label}`}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={!invitationLink}
            onClick={() => {
              void writeClipboardText(
                invitationLink ?? "",
              ).then((copied) => setStatus(copied
                ? "Secure pairing link copied."
                : "The pairing link could not be copied."));
            }}
          >
            <Copy size={14} />Copy pairing link
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void mutate(
              async () => {
                await window.inertia.createRemotePairingInvitation();
                return await window.inertia.getRemoteAccessState();
              },
              "Invitation regenerated. The previous link no longer works.",
            )}
          >
            <RefreshCw size={14} />Regenerate
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void mutate(
              () => window.inertia.denyRemotePairing(
                current.invitation!.invitationId,
              ),
              "Invitation cancelled.",
            )}
          >
            <X size={14} />Cancel
          </button>
          <details>
            <summary>Advanced: raw invitation JSON</summary>
            <textarea
              className="remote-invitation"
              value={JSON.stringify(current.invitation)}
              rows={5}
              readOnly
              aria-label="Remote Companion invitation JSON"
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void writeClipboardText(
                  JSON.stringify(current.invitation),
                ).then((copied) => setStatus(copied
                  ? "Raw invitation JSON copied."
                  : "The invitation JSON could not be copied."));
              }}
            >
              <Copy size={14} />Copy raw JSON
            </button>
          </details>
        </section>
      )}

      {current.pendingPairings.map((pending) => (
        <section className="settings-card remote-pairing-card" key={pending.requestId}>
          <div className="settings-card-heading">
            <div><RadioTower size={18} /></div>
            <span>
              <h3>Approve {pending.deviceLabel}?</h3>
              <p>Compare this code with the browser. A mismatch means stop and deny the request.</p>
            </span>
          </div>
          <div className="remote-comparison-code">{pending.comparisonCode}</div>
          {pending.replacesDeviceLabel && (
            <p className="settings-card-note" role="status">
              Approving replaces the existing paired device “{pending.replacesDeviceLabel}” and ends its sessions.
            </p>
          )}
          <ProjectScope
            projects={projects}
            selected={projectIds}
            onChange={setProjectIds}
          />
          <div className="setting-row">
            <span className="setting-copy">
              <strong>Allow text prompts</strong>
              <small>Starts supervised turns only. The selected agent can read the granted project's files, and its answer can include project-derived text. Approvals, direct file transfer, terminal, Git, settings, secret-input requests, and destructive actions stay desktop-only.</small>
            </span>
            <Switch
              label="Allow text prompts"
              checked={prompting}
              onChange={(allowed) => {
                setPrompting(allowed);
                if (allowed) {
                  setGrantDays((days) =>
                    Math.min(days, MAX_PROMPT_EXPIRY_DAYS));
                }
              }}
            />
          </div>
          <label className="remote-expiry-setting">
            <span>Permission expiry</span>
            <select
              value={grantDays}
              onChange={(event) => setGrantDays(Number(event.target.value))}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              {!prompting && <option value={30}>30 days</option>}
              {!prompting && <option value={90}>90 days</option>}
            </select>
          </label>
          <ConversationGrantEditor
            projects={projects}
            conversations={conversations}
            projectIds={projectIds}
            grants={selectedGrants}
            onChange={setGrants}
          />
          <p className="settings-card-note" role="status">
            Exact grant: {prompting ? "view + supervised text prompts" : "view only"}; {selectedGrants.length} project grant{selectedGrants.length === 1 ? "" : "s"}; expires in {grantDays} day{grantDays === 1 ? "" : "s"}. Only the conversations selected above are included.
          </p>
          <div className="remote-pairing-actions">
            <button
              type="button"
              disabled={
                busy
                || projectIds.length === 0
                || !remoteGrantsAllowSomething(selectedGrants)
              }
              onClick={() => void mutate(
                () => window.inertia.approveRemotePairing({
                  requestId: pending.requestId,
                  scopes: prompting ? ["view", "prompt"] : ["view"],
                  projectIds,
                  grants: selectedGrants,
                  grantDays,
                }),
                `${pending.deviceLabel} paired.`,
              )}
            >
              <Check size={14} />Approve
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void mutate(
                () => window.inertia.denyRemotePairing(pending.requestId),
                "Pairing denied.",
              )}
            >
              Deny
            </button>
          </div>
        </section>
      ))}

      <section className="settings-card" aria-labelledby="remote-devices-heading">
        <div className="settings-card-heading">
          <div><ShieldCheck size={18} /></div>
          <span>
            <h3 id="remote-devices-heading">Paired devices</h3>
            <p>Permissions are device-specific, project-scoped, revocable, and time-limited.</p>
          </span>
        </div>
        {current.devices.length === 0 ? (
          <div className="settings-empty-state">No browsers are paired.</div>
        ) : current.devices.map((device) => (
          <RemoteDevice
            key={`${device.id}:${device.expiresAt}:${device.scopes.join(",")}`}
            device={device}
            projects={projects}
            conversations={conversations}
            disabled={busy}
            update={(scopes, nextProjectIds, nextGrants, expiresAt) => mutate(
              () => window.inertia.updateRemoteDevice({
                deviceId: device.id,
                scopes,
                projectIds: nextProjectIds,
                grants: nextGrants,
                expiresAt,
              }),
              `${device.label} permissions updated.`,
            )}
            revoke={() => mutate(
              () => window.inertia.revokeRemoteDevice(device.id),
              `${device.label} revoked.`,
            )}
          />
        ))}
      </section>

      <section className="settings-card" aria-labelledby="remote-audit-heading">
        <div className="settings-card-heading">
          <div><ShieldCheck size={18} /></div>
          <span>
            <h3 id="remote-audit-heading">Local audit history</h3>
            <p>Bounded security events only. Prompt text, source, paths, credentials, and encrypted payloads are never logged.</p>
          </span>
        </div>
        <div className="remote-audit-list">
          {current.audit.length === 0
            ? <span className="settings-card-note">No remote events yet.</span>
            : current.audit.slice(0, 20).map((event) => (
              <div key={event.id}>
                <strong>{event.detail}</strong>
                <small>{new Date(event.createdAt).toLocaleString()}</small>
              </div>
            ))}
        </div>
      </section>
    </>
  );
}

function RemoteDevice({
  device,
  projects,
  conversations,
  disabled,
  update,
  revoke,
}: {
  device: RemoteDeviceView;
  projects: Project[];
  conversations: Conversation[];
  disabled: boolean;
  update(
    scopes: RemoteScope[],
    projectIds: string[],
    grants: RemoteConversationGrant[],
    expiresAt: string,
  ): Promise<void>;
  revoke(): Promise<void>;
}): React.JSX.Element {
  const [prompting, setPrompting] = useState(device.scopes.includes("prompt"));
  const [projectIds, setProjectIds] = useState(device.projectIds);
  const [grants, setGrants] = useState(device.grants);
  const [expiryDays, setExpiryDays] = useState(
    prompting ? MAX_PROMPT_EXPIRY_DAYS : 30,
  );
  const projectNames = useMemo(
    () => projects
      .filter(({ id }) => device.projectIds.includes(id))
      .map(({ name }) => name)
      .join(", "),
    [device.projectIds, projects],
  );
  return (
    <div className="remote-device">
      <div className="remote-device-heading">
        <span>
          <strong>{device.label}</strong>
          <small>
            {device.revokedAt
              ? `Revoked ${new Date(device.revokedAt).toLocaleString()}`
              : `Expires ${new Date(device.expiresAt).toLocaleString()}`}
            {projectNames ? ` · ${projectNames}` : ""}
          </small>
        </span>
        {!device.revokedAt && (
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void revoke()}>
            <Trash2 size={14} />Revoke
          </button>
        )}
      </div>
      <DeviceAccessPreview
        device={device}
        projects={projects}
        conversations={conversations}
      />
      {device.needsGrantReview && !device.revokedAt && (
        <p className="settings-card-note" role="status">
          Review this device: it still has project-wide access granted before
          conversation-level permissions existed.
        </p>
      )}
      {!device.revokedAt && (
        <details>
          <summary>Edit permissions</summary>
          <ProjectScope
            projects={projects}
            selected={projectIds}
            onChange={setProjectIds}
          />
          <ConversationGrantEditor
            projects={projects}
            conversations={conversations}
            projectIds={projectIds}
            grants={grants}
            onChange={setGrants}
          />
          <label className="remote-checkbox">
            <input
              type="checkbox"
              checked={prompting}
              onChange={(event) => {
                const allowed = event.target.checked;
                setPrompting(allowed);
                if (allowed) {
                  setExpiryDays((days) =>
                    Math.min(days, MAX_PROMPT_EXPIRY_DAYS));
                }
              }}
            />
            Allow text prompts
          </label>
          {prompting && (
            <p className="settings-card-note">
              The selected agent can read this project's files, and its remote
              answer can include project-derived text.
            </p>
          )}
          <label className="remote-expiry-setting">
            <span>Reset expiry</span>
            <select value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
              <option value={1}>1 day from now</option>
              <option value={7}>7 days from now</option>
              {!prompting && <option value={30}>30 days from now</option>}
              {!prompting && <option value={90}>90 days from now</option>}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || projectIds.length === 0}
            onClick={() => void update(
              prompting ? ["view", "prompt"] : ["view"],
              projectIds,
              grants,
              new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1_000).toISOString(),
            )}
          >
            Save permissions
          </button>
        </details>
      )}
    </div>
  );
}

function ProjectScope({
  projects,
  selected,
  onChange,
}: {
  projects: Project[];
  selected: string[];
  onChange(projectIds: string[]): void;
}): React.JSX.Element {
  return (
    <fieldset className="remote-project-scope">
      <legend>Visible projects</legend>
      {projects.map((project) => (
        <label key={project.id}>
          <input
            type="checkbox"
            checked={selected.includes(project.id)}
            onChange={(event) => onChange(
              event.target.checked
                ? [...new Set([...selected, project.id])]
                : selected.filter((id) => id !== project.id),
            )}
          />
          {project.name}
        </label>
      ))}
    </fieldset>
  );
}
