import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Check, Copy, RadioTower, ShieldCheck, Trash2 } from "lucide-react";

import type { Project } from "@shared/contracts";
import type {
  RemoteAccessState,
  RemoteDeviceView,
  RemoteScope,
} from "@shared/remote-protocol";
import { useRemoteAccessState } from "../hooks/useRemoteAccessState";
import { writeClipboardText } from "../utils/clipboard";
import { Switch } from "./ui";

export function RemoteAccessSettings({
  projects,
}: {
  projects: Project[];
}): React.JSX.Element {
  const liveState = useRemoteAccessState();
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [prompting, setPrompting] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [grantDays, setGrantDays] = useState(30);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = liveState ?? state;

  useEffect(() => {
    if (!liveState) return;
    setState(liveState);
    setRelayUrl((value) => value || liveState.relayUrl);
  }, [liveState]);

  const pendingPairingIds = current?.pendingPairings
    .map(({ requestId }) => requestId)
    .join(",") ?? "";
  useLayoutEffect(() => {
    setProjectIds([]);
    setPrompting(false);
  }, [pendingPairingIds]);

  const mutate = async (
    operation: () => Promise<RemoteAccessState>,
    success: string,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const next = await operation();
      setState(next);
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Remote Companion could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  if (!current) {
    return <div className="settings-empty-state">Loading Remote Companion…</div>;
  }

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
            <div className="setting-row">
              <span className="setting-row-icon"><ShieldCheck size={17} /></span>
              <span className="setting-copy">
                <strong>Allow remote access</strong>
                <small>Off by default. Disabling closes every remote session immediately.</small>
              </span>
              <Switch
                label="Allow remote access"
                checked={current.enabled}
                disabled={busy}
                onChange={(enabled) => {
                  void mutate(
                    () => window.inertia.setRemoteAccessEnabled({
                      enabled,
                      relayUrl,
                    }),
                    enabled ? "Remote Companion enabled." : "Remote Companion disabled.",
                  );
                }}
              />
            </div>
            <label className="remote-relay-setting">
              <span>Relay WebSocket URL</span>
              <input
                value={relayUrl}
                maxLength={2_048}
                disabled={busy || current.enabled}
                onChange={(event) => setRelayUrl(event.target.value)}
              />
              <small>Use wss://. Plain ws:// is accepted only on loopback for local development.</small>
            </label>
            <p className="settings-card-note">
              Status: {current.connection}
              {current.connectionMessage ? ` · ${current.connectionMessage}` : ""}
              {current.activeSessions > 0 ? ` · ${current.activeSessions} active browser session${current.activeSessions === 1 ? "" : "s"}` : ""}
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !current.enabled || current.connection !== "online"}
              onClick={() => {
                void window.inertia.createRemotePairingInvitation().then(
                  () => setStatus("Invitation created. It expires in five minutes."),
                  (error: unknown) => setStatus(error instanceof Error ? error.message : "Invitation creation failed."),
                );
              }}
            >
              Create pairing invitation
            </button>
          </>
        )}
        {status && <p className="settings-card-note" role="status">{status}</p>}
      </section>

      {current.invitation && (
        <section className="settings-card" aria-labelledby="remote-invitation-heading">
          <div className="settings-card-heading">
            <div><Copy size={18} /></div>
            <span>
              <h3 id="remote-invitation-heading">Short-lived invitation</h3>
              <p>Transfer this only to the browser you are pairing. The relay cannot use it to decrypt a session.</p>
            </span>
          </div>
          <textarea
            className="remote-invitation"
            value={JSON.stringify(current.invitation)}
            rows={5}
            readOnly
            aria-label="Remote Companion invitation"
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void writeClipboardText(
                JSON.stringify(current.invitation),
              ).then((copied) => setStatus(copied
                ? "Invitation copied."
                : "The invitation could not be copied."));
            }}
          >
            <Copy size={14} />Copy invitation
          </button>
          <p className="settings-card-note">Expires {new Date(current.invitation.expiresAt).toLocaleString()}.</p>
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
              <small>Starts supervised turns only. Approvals, files, terminal, Git, settings, secrets, and destructive actions stay desktop-only.</small>
            </span>
            <Switch
              label="Allow text prompts"
              checked={prompting}
              onChange={setPrompting}
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
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <div className="remote-pairing-actions">
            <button
              type="button"
              disabled={busy || projectIds.length === 0}
              onClick={() => void mutate(
                () => window.inertia.approveRemotePairing({
                  requestId: pending.requestId,
                  scopes: prompting ? ["view", "prompt"] : ["view"],
                  projectIds,
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
            disabled={busy}
            update={(scopes, nextProjectIds, expiresAt) => mutate(
              () => window.inertia.updateRemoteDevice({
                deviceId: device.id,
                scopes,
                projectIds: nextProjectIds,
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
  disabled,
  update,
  revoke,
}: {
  device: RemoteDeviceView;
  projects: Project[];
  disabled: boolean;
  update(
    scopes: RemoteScope[],
    projectIds: string[],
    expiresAt: string,
  ): Promise<void>;
  revoke(): Promise<void>;
}): React.JSX.Element {
  const [prompting, setPrompting] = useState(device.scopes.includes("prompt"));
  const [projectIds, setProjectIds] = useState(device.projectIds);
  const [expiryDays, setExpiryDays] = useState(30);
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
      {!device.revokedAt && (
        <details>
          <summary>Edit permissions</summary>
          <ProjectScope
            projects={projects}
            selected={projectIds}
            onChange={setProjectIds}
          />
          <label className="remote-checkbox">
            <input
              type="checkbox"
              checked={prompting}
              onChange={(event) => setPrompting(event.target.checked)}
            />
            Allow text prompts
          </label>
          <label className="remote-expiry-setting">
            <span>Reset expiry</span>
            <select value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
              <option value={1}>1 day from now</option>
              <option value={7}>7 days from now</option>
              <option value={30}>30 days from now</option>
              <option value={90}>90 days from now</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || projectIds.length === 0}
            onClick={() => void update(
              prompting ? ["view", "prompt"] : ["view"],
              projectIds,
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
