import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Project } from "@shared/contracts";
import type {
  PrivateConnectDeviceView,
  PrivateConnectStateView,
} from "@shared/private-connect/protocol";
import type { PrivateConnectPreset } from "@shared/private-connect/scopes";
import { usePrivateConnectState } from "../hooks/usePrivateConnectState";
import { writeClipboardText } from "../utils/clipboard";

type UpdateState = (
  operation: () => Promise<PrivateConnectStateView>,
  success: string,
) => Promise<void>;

export function ConnectionsAndDevicesSettings({
  projects,
}: {
  projects: Project[];
}): React.JSX.Element {
  const loaded = usePrivateConnectState();
  const [state, setState] = useState<PrivateConnectStateView | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [projectSelections, setProjectSelections] = useState<
    Record<string, string[]>
  >({});

  useEffect(() => setState(loaded.state), [loaded.state]);
  useEffect(() => {
    if (!state?.invitation?.url) {
      setQr(null);
      return;
    }
    void QRCode.toDataURL(state.invitation.url, { width: 220, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [state?.invitation?.url]);

  if (loaded.error) {
    return (
      <section className="settings-card">
        <h3>Inertia Private Connect</h3>
        <p>{loaded.error}</p>
        <button type="button" onClick={loaded.retry}>Retry</button>
      </section>
    );
  }
  if (!state) {
    return (
      <section className="settings-card">
        <h3>Inertia Private Connect</h3>
        <p>Loading Private Connect…</p>
      </section>
    );
  }

  const update: UpdateState = async (operation, success) => {
    setBusy(true);
    setMessage(null);
    try {
      setState(await operation());
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message
        : "Private Connect could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const createInvitation = (): Promise<void> => update(async () => {
    const invitation = await window.inertia.createPrivateConnectInvitation();
    setMessage(
      `Pairing link ready until ${new Date(invitation.expiresAt).toLocaleTimeString()}.`,
    );
    return await window.inertia.getPrivateConnectState();
  }, "Pairing link ready.");

  const copyInvitation = async (): Promise<void> => {
    if (!state.invitation) return;
    try {
      if (!await writeClipboardText(state.invitation.url)) throw new Error("Clipboard write failed.");
      setMessage("Pairing link copied.");
    } catch {
      setMessage("Copy failed. Select the link and copy it manually.");
    }
  };

  const currentDevices = state.devices.filter((device) =>
    device.revokedAt === null && Date.parse(device.expiresAt) > Date.now()
  );

  return (
    <div className="settings-stack">
      <section className="settings-card" aria-labelledby="private-connect-heading">
        <div className="settings-card-heading">
          <div><span className={`status-dot ${state.status}`} /></div>
          <span>
            <h3 id="private-connect-heading">Inertia Private Connect</h3>
            <p>Use your own Tailscale tailnet to open this online computer on another device.</p>
          </span>
        </div>
        <div className="settings-rows private-connect-settings-rows">
          <div className="settings-row">
            <span><strong>Status</strong><small>{statusLabel(state)}</small></span>
            <button
              type="button"
              disabled={busy || !state.available}
              onClick={() => void update(
                () => window.inertia.setPrivateConnectEnabled({ enabled: !state.enabled }),
                state.enabled ? "Private Connect disabled." : "Private Connect ready.",
              )}
            >
              {state.enabled ? "Disable" : "Enable"}
            </button>
          </div>
          <div className="settings-row">
            <span>
              <strong>Open on another device</strong>
              <small>{state.externalUrl ?? "Enable Private Connect to create a private link."}</small>
            </span>
            <button
              type="button"
              disabled={busy || state.status !== "ready"}
              onClick={() => void createInvitation()}
            >
              Create pairing link
            </button>
          </div>
        </div>
        {state.status === "error" && (
          <p className="settings-card-note">
            {state.statusMessage ?? "Private Connect could not be established safely."}
          </p>
        )}
        {state.diagnostics.setupUrl && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void window.inertia.openExternal(state.diagnostics.setupUrl!)}
          >
            Finish Tailscale setup
          </button>
        )}
        {state.notice && <p className="settings-card-note">{state.notice}</p>}
        {message && <p className="settings-card-note" role="status">{message}</p>}
      </section>

      {state.invitation && (
        <section className="settings-card" aria-labelledby="pairing-link-heading">
          <div className="settings-card-heading">
            <div>QR</div>
            <span>
              <h3 id="pairing-link-heading">Pair a browser</h3>
              <p>This link expires in five minutes and is safe to share only with a device on your tailnet.</p>
            </span>
          </div>
          {qr && (
            <img
              className="private-connect-qr"
              src={qr}
              alt="Short-lived Private Connect pairing QR code"
            />
          )}
          <div className="settings-actions">
            <input
              aria-label="Private Connect pairing link"
              value={state.invitation.url}
              readOnly
            />
            <button type="button" onClick={() => void copyInvitation()}>Copy link</button>
          </div>
        </section>
      )}

      <section className="settings-card" aria-labelledby="paired-devices-heading">
        <div className="settings-card-heading">
          <div>●</div>
          <span>
            <h3 id="paired-devices-heading">Paired devices</h3>
            <p>Monitor is read-only. Collaborate can prompt, answer non-secret questions, and stop an active run.</p>
          </span>
        </div>
        {currentDevices.length === 0 ? (
          <p className="settings-card-note">No browsers are paired.</p>
        ) : (
          <div className="private-connect-device-list">
            {currentDevices.map((device) => (
              <PairedDeviceEditor
                key={device.id}
                device={device}
                projects={projects}
                busy={busy}
                update={update}
              />
            ))}
          </div>
        )}
      </section>

      {state.pendingPairings.map((pending) => {
        const selected = projectSelections[pending.requestId] ?? [];
        const toggleProject = (projectId: string): void => {
          setProjectSelections((current) => ({
            ...current,
            [pending.requestId]: selected.includes(projectId)
              ? selected.filter((id) => id !== projectId)
              : [...selected, projectId],
          }));
        };
        return (
          <section
            className="settings-card pairing-approval"
            key={pending.requestId}
            aria-labelledby={`pairing-${pending.requestId}`}
          >
            <h3 id={`pairing-${pending.requestId}`}>{pending.deviceLabel} wants to connect</h3>
            <p>Comparison code: <strong className="private-connect-code">{pending.comparisonCode}</strong></p>
            <p className="settings-card-note">Network metadata: {pending.tailnetLabel ?? "not available"}</p>
            <ProjectGrantFields
              projects={projects}
              selected={selected}
              onToggle={toggleProject}
            />
            <div className="settings-actions">
              <button
                type="button"
                disabled={busy || selected.length === 0}
                onClick={() => void update(
                  () => window.inertia.approvePrivateConnectPairing({
                    requestId: pending.requestId,
                    preset: "monitor",
                    projectIds: selected,
                    grantDays: 30,
                  }),
                  "Monitor access approved.",
                )}
              >
                Allow Monitor
              </button>
              <button
                type="button"
                disabled={busy || selected.length === 0}
                onClick={() => void update(
                  () => window.inertia.approvePrivateConnectPairing({
                    requestId: pending.requestId,
                    preset: "collaborate",
                    projectIds: selected,
                    grantDays: 30,
                  }),
                  "Collaborate access approved.",
                )}
              >
                Allow Collaborate
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void update(
                  () => window.inertia.denyPrivateConnectPairing(pending.requestId),
                  "Pairing denied.",
                )}
              >
                Deny
              </button>
            </div>
          </section>
        );
      })}

      <section className="settings-card" aria-labelledby="private-connect-security-heading">
        <div className="settings-card-heading">
          <div>↺</div>
          <span>
            <h3 id="private-connect-security-heading">Security activity</h3>
            <p>Recent local authority events. Prompt text and private content are never recorded here.</p>
          </span>
        </div>
        {(state.audit ?? []).length === 0 ? (
          <p className="settings-card-note">No Private Connect security activity yet.</p>
        ) : (
          <div className="private-connect-audit-list">
            {[...(state.audit ?? [])].reverse().map((event) => (
              <div key={event.id}>
                <span><strong>{event.detail}</strong><small>{event.type}</small></span>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
            ))}
          </div>
        )}
      </section>

      <details className="settings-card private-connect-diagnostics">
        <summary>Advanced diagnostics</summary>
        <dl>
          <div><dt>Tailscale</dt><dd>{state.diagnostics.tailscale}</dd></div>
          <div><dt>MagicDNS</dt><dd>{state.diagnostics.magicDns}</dd></div>
          <div><dt>Gateway port</dt><dd>{state.diagnostics.gatewayPort ?? "off"}</dd></div>
          <div><dt>Serve port</dt><dd>{state.diagnostics.servePort ?? "off"}</dd></div>
          <div><dt>Mapping</dt><dd>{state.diagnostics.mappingOwnership}</dd></div>
          <div><dt>Inertia</dt><dd>{state.diagnostics.buildVersion ?? "unknown"}</dd></div>
          <div><dt>Protocol</dt><dd>{state.diagnostics.protocolVersion ?? 1}</dd></div>
          {state.diagnostics.errorClass && (
            <div><dt>Last safe error</dt><dd>{state.diagnostics.errorClass}</dd></div>
          )}
        </dl>
      </details>
    </div>
  );
}

function PairedDeviceEditor({
  device,
  projects,
  busy,
  update,
}: {
  device: PrivateConnectDeviceView;
  projects: Project[];
  busy: boolean;
  update: UpdateState;
}): React.JSX.Element {
  const [preset, setPreset] = useState<PrivateConnectPreset>(device.preset);
  const [projectIds, setProjectIds] = useState(device.projectIds);
  const [expiresAt, setExpiresAt] = useState(toLocalDateTime(device.expiresAt));

  useEffect(() => {
    setPreset(device.preset);
    setProjectIds(device.projectIds);
    setExpiresAt(toLocalDateTime(device.expiresAt));
  }, [device]);

  const toggleProject = (projectId: string): void => {
    setProjectIds((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId]);
  };
  const save = (): Promise<void> => update(
    () => window.inertia.updatePrivateConnectDevice({
      deviceId: device.id,
      preset,
      projectIds,
      expiresAt: new Date(expiresAt).toISOString(),
    }),
    `${device.label} access updated. The browser must reconnect.`,
  );

  return (
    <article className="private-connect-device">
      <div className="private-connect-device-heading">
        <span>
          <strong>{device.label}</strong>
          <small>
            Last connected {device.lastSeenAt
              ? new Date(device.lastSeenAt).toLocaleString()
              : "not yet"}
          </small>
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void update(
            () => window.inertia.revokePrivateConnectDevice(device.id),
            "Device revoked.",
          )}
        >
          Revoke
        </button>
      </div>
      <div className="settings-form-grid private-connect-device-fields">
        <label>
          Access
          <select
            aria-label={`${device.label} access`}
            value={preset}
            onChange={(event) => setPreset(event.currentTarget.value as PrivateConnectPreset)}
          >
            <option value="monitor">Monitor</option>
            <option value="collaborate">Collaborate</option>
          </select>
        </label>
        <label>
          Expires
          <input
            type="datetime-local"
            aria-label={`${device.label} expiry`}
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.currentTarget.value)}
          />
        </label>
      </div>
      <ProjectGrantFields
        projects={projects}
        selected={projectIds}
        onToggle={toggleProject}
      />
      <div className="settings-actions">
        <button
          type="button"
          disabled={busy || projectIds.length === 0 || !validFutureDate(expiresAt)}
          onClick={() => void save()}
        >
          Save access
        </button>
      </div>
    </article>
  );
}

function ProjectGrantFields({
  projects,
  selected,
  onToggle,
}: {
  projects: Project[];
  selected: string[];
  onToggle: (projectId: string) => void;
}): React.JSX.Element {
  return (
    <fieldset className="private-connect-projects">
      <legend>Projects this device may access</legend>
      {projects.length === 0 ? (
        <p className="settings-card-note">No projects are available to share.</p>
      ) : projects.map((project) => (
        <label key={project.id}>
          <input
            type="checkbox"
            checked={selected.includes(project.id)}
            onChange={() => onToggle(project.id)}
          />
          <span>{project.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function statusLabel(state: PrivateConnectStateView): string {
  if (state.statusMessage) return state.statusMessage;
  if (state.status === "ready") {
    return `${state.activeSessions} connected browser${state.activeSessions === 1 ? "" : "s"}`;
  }
  if (state.status === "starting") return "Starting…";
  return "Off";
}

function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function validFutureDate(value: string): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}
