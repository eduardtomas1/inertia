import { INTERFACE_LOCALE } from "../lib/locale";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Copy, ExternalLink, Link, Power } from "lucide-react";
import type { Project } from "@shared/contracts";
import type {
  PrivateConnectDeviceView,
  PrivateConnectStateView,
} from "@shared/private-connect/protocol";
import type { PrivateConnectPreset } from "@shared/private-connect/scopes";
import { usePrivateConnectState } from "../hooks/usePrivateConnectState";
import { writeClipboardText } from "../utils/clipboard";
import {
  SettingActionRow,
  SettingCopy,
  SettingDisclosure,
  SettingNoteStatus,
  SettingsGroup,
} from "./settings/SettingsLayout";
import type { SettingNotice } from "./settings/useSettingAction";
import "./ConnectionsAndDevicesSettings.css";

type UpdateState = (
  operation: () => Promise<PrivateConnectStateView>,
  success: string | (() => string),
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
  const [message, setMessage] = useState<SettingNotice | null>(null);
  const [projectSelections, setProjectSelections] = useState<
    Record<string, string[]>
  >({});

  useEffect(() => setState(loaded.state), [loaded.state]);
  useEffect(() => {
    if (!state?.invitation?.url) {
      setQr(null);
      return;
    }
    let current = true;
    void QRCode.toDataURL(state.invitation.url, { width: 220, margin: 1 })
      .then((value) => { if (current) setQr(value); })
      .catch(() => { if (current) setQr(null); });
    return () => { current = false; };
  }, [state?.invitation?.url]);

  if (loaded.error || !state) {
    return (
      <SettingsGroup title="Inertia Private Connect" headingId="private-connect-heading" className="private-connect-settings">
        <SettingActionRow
          id="private-connect"
          className="runtime-log-setting"
          title="Status"
          details={<small role="status">{loaded.error ?? "Loading Private Connect…"}</small>}
          actions={loaded.error
            ? <button type="button" className="secondary-button" onClick={loaded.retry}>Retry</button>
            : undefined}
        />
      </SettingsGroup>
    );
  }

  const update: UpdateState = async (operation, success) => {
    setBusy(true);
    setMessage(null);
    try {
      setState(await operation());
      setMessage({ tone: "info", text: typeof success === "string" ? success : success() });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Private Connect could not be updated.",
      });
    } finally {
      setBusy(false);
    }
  };

  const createInvitation = (): Promise<void> => {
    let expiresAt = "";
    return update(async () => {
      ({ expiresAt } = await window.inertia.createPrivateConnectInvitation());
      return await window.inertia.getPrivateConnectState();
    }, () => `Pairing link ready until ${new Date(expiresAt).toLocaleTimeString(INTERFACE_LOCALE)}.`);
  };

  const copyInvitation = async (): Promise<void> => {
    if (!state.invitation) return;
    try {
      if (!await writeClipboardText(state.invitation.url)) throw new Error("Clipboard write failed.");
      setMessage({ tone: "info", text: "Pairing link copied." });
    } catch {
      setMessage({ tone: "error", text: "Copy failed. Select the link and copy it manually." });
    }
  };

  const currentDevices = state.devices.filter((device) =>
    device.revokedAt === null && Date.parse(device.expiresAt) > Date.now()
  );
  const toggleUnavailable = busy || !state.available;
  const pairingUnavailable = busy || state.status !== "ready";

  return (
    <>
      <SettingsGroup
        title="Inertia Private Connect"
        headingId="private-connect-heading"
        description="Open Inertia on another device through your own Tailscale tailnet."
        className="private-connect-settings"
      >
        <SettingActionRow
          id="private-connect"
          className="runtime-log-setting"
          title="Status"
          description={statusLabel(state)}
          actions={(
            <>
              {state.diagnostics.setupUrl && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void window.inertia.openExternal(state.diagnostics.setupUrl!)}
                >
                  <ExternalLink size={14} aria-hidden="true" />Finish Tailscale setup
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                aria-disabled={toggleUnavailable || undefined}
                onClick={() => {
                  if (toggleUnavailable) return;
                  void update(
                    () => window.inertia.setPrivateConnectEnabled({ enabled: !state.enabled }),
                    state.enabled ? "Private Connect disabled." : "Private Connect ready.",
                  );
                }}
              >
                <Power size={14} aria-hidden="true" />{state.enabled ? "Disable" : "Enable"}
              </button>
            </>
          )}
        />
        <SettingActionRow
          className="runtime-log-setting"
          title="Open on another device"
          description={state.externalUrl ?? "Turn on Private Connect to create a private link."}
          actions={(
            <button
              type="button"
              className="secondary-button"
              aria-disabled={pairingUnavailable || undefined}
              onClick={() => {
                if (!pairingUnavailable) void createInvitation();
              }}
            >
              <Link size={14} aria-hidden="true" />Create pairing link
            </button>
          )}
        />
        {state.invitation && (
          <div className="private-connect-pairing" role="group" aria-labelledby="pairing-link-heading">
            <SettingCopy
              title="Pairing link"
              titleId="pairing-link-heading"
              description="Expires in five minutes. Share it only with a device on your tailnet."
            />
            {qr && (
              <img
                className="private-connect-qr"
                src={qr}
                alt="Short-lived Private Connect pairing QR code"
              />
            )}
            <div className="private-connect-link">
              <input
                className="setting-input"
                aria-label="Private Connect pairing link"
                value={state.invitation.url}
                readOnly
              />
              <button type="button" className="secondary-button" onClick={() => void copyInvitation()}>
                <Copy size={14} aria-hidden="true" />Copy link
              </button>
            </div>
          </div>
        )}
        {state.status === "error" && (
          <p className="private-connect-note">
            {state.statusMessage ?? "Private Connect could not be established safely."}
          </p>
        )}
        {state.notice && <p className="private-connect-note">{state.notice}</p>}
        <SettingNoteStatus notice={message} />
      </SettingsGroup>

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
        const approvalUnavailable = busy || selected.length === 0;
        const approve = (preset: PrivateConnectPreset, success: string): void => {
          if (approvalUnavailable) return;
          void update(
            () => window.inertia.approvePrivateConnectPairing({
              requestId: pending.requestId,
              preset,
              projectIds: selected,
              grantDays: 30,
            }),
            success,
          );
        };
        return (
          <SettingsGroup
            key={pending.requestId}
            title={`${pending.deviceLabel} wants to connect`}
            headingId={`pairing-${pending.requestId}`}
            className="private-connect-approval"
          >
            <p className="private-connect-facts">
              Comparison code <strong className="private-connect-code">{pending.comparisonCode}</strong>
              {" · "}Network {pending.tailnetLabel ?? "not available"}
            </p>
            <ProjectGrantFields
              projects={projects}
              selected={selected}
              onToggle={toggleProject}
            />
            <div className="private-connect-actions">
              <button
                type="button"
                className="secondary-button"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void update(() => window.inertia.denyPrivateConnectPairing(pending.requestId), "Pairing denied.");
                }}
              >
                Deny
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-disabled={approvalUnavailable || undefined}
                onClick={() => approve("monitor", "Monitor access approved.")}
              >
                Allow Monitor
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-disabled={approvalUnavailable || undefined}
                onClick={() => approve("collaborate", "Collaborate access approved.")}
              >
                Allow Collaborate
              </button>
            </div>
          </SettingsGroup>
        );
      })}

      <div data-setting-id="paired-devices">
        <SettingsGroup
          title="Paired devices"
          headingId="paired-devices-heading"
          description="Monitor is read-only. Collaborate can prompt, answer non-secret questions and stop an active run."
          className="private-connect-devices"
        >
          {currentDevices.length === 0 ? (
            <p className="private-connect-note">No browsers are paired.</p>
          ) : currentDevices.map((device) => (
            <PairedDeviceEditor
              key={device.id}
              device={device}
              projects={projects}
              busy={busy}
              update={update}
            />
          ))}
          <SettingDisclosure summary="Security activity" className="private-connect-disclosure">
            <p className="private-connect-note">Recent local authority events. Prompt text and private content are never recorded.</p>
            {(state.audit ?? []).length === 0 ? (
              <p className="private-connect-note">No security activity yet.</p>
            ) : (
              <ul className="private-connect-audit-list" aria-label="Security activity">
                {[...(state.audit ?? [])].reverse().map((event) => (
                  <li key={event.id}>
                    <span><strong>{event.detail}</strong><small>{event.type}</small></span>
                    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString(INTERFACE_LOCALE)}</time>
                  </li>
                ))}
              </ul>
            )}
          </SettingDisclosure>
          <SettingDisclosure summary="Advanced diagnostics" className="private-connect-disclosure private-connect-diagnostics">
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
          </SettingDisclosure>
        </SettingsGroup>
      </div>
    </>
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
  const initialExpiresAt = toLocalDateTime(device.expiresAt);
  const [preset, setPreset] = useState<PrivateConnectPreset>(device.preset);
  const [projectIds, setProjectIds] = useState(device.projectIds);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const previousAuthority = useRef({
    preset: device.preset,
    projectIds: device.projectIds,
    expiresAt: initialExpiresAt,
  });

  useEffect(() => {
    const nextExpiresAt = toLocalDateTime(device.expiresAt);
    const previous = previousAuthority.current;
    if (
      previous.preset === device.preset
      && sameProjectIds(previous.projectIds, device.projectIds)
      && previous.expiresAt === nextExpiresAt
    ) return;
    previousAuthority.current = {
      preset: device.preset,
      projectIds: device.projectIds,
      expiresAt: nextExpiresAt,
    };
    setPreset(device.preset);
    setProjectIds(device.projectIds);
    setExpiresAt(nextExpiresAt);
  }, [device.expiresAt, device.preset, device.projectIds]);

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

  const saveUnavailable = busy || projectIds.length === 0 || !validFutureDate(expiresAt);

  return (
    <div className="private-connect-device" role="group" aria-label={device.label}>
      <div className="private-connect-device-heading">
        <span className="setting-copy">
          <strong>{device.label}</strong>
          <small>
            Last connected {device.lastSeenAt
              ? new Date(device.lastSeenAt).toLocaleString(INTERFACE_LOCALE)
              : "not yet"}
          </small>
        </span>
        <button
          type="button"
          className="secondary-button"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) void update(() => window.inertia.revokePrivateConnectDevice(device.id), "Device revoked.");
          }}
        >
          Revoke
        </button>
      </div>
      <div className="private-connect-device-fields">
        <label>
          Access
          <select
            className="setting-select"
            aria-label={`Access for ${device.label}`}
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
            className="setting-input"
            type="datetime-local"
            aria-label={`Expires for ${device.label}`}
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
      <div className="private-connect-actions">
        <button
          type="button"
          className="secondary-button"
          aria-disabled={saveUnavailable || undefined}
          onClick={() => {
            if (!saveUnavailable) void save();
          }}
        >
          Save access
        </button>
      </div>
    </div>
  );
}

function sameProjectIds(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((projectId) => right.includes(projectId));
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
        <p className="private-connect-note">No projects are available to share.</p>
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
