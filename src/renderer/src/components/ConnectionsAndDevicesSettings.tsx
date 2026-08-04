import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Project } from "@shared/contracts";
import type { PrivateConnectStateView } from "@shared/private-connect/protocol";
import { usePrivateConnectState } from "../hooks/usePrivateConnectState";

export function ConnectionsAndDevicesSettings({ projects }: { projects: Project[] }): React.JSX.Element {
  const loaded = usePrivateConnectState();
  const [state, setState] = useState<PrivateConnectStateView | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [projectSelections, setProjectSelections] = useState<Record<string, string[]>>({});
  useEffect(() => setState(loaded.state), [loaded.state]);
  useEffect(() => {
    if (!state?.invitation?.url) { setQr(null); return; }
    void QRCode.toDataURL(state.invitation.url, { width: 220, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [state?.invitation?.url]);
  if (loaded.error) return <section className="settings-card"><h3>Inertia Private Connect</h3><p>{loaded.error}</p><button type="button" onClick={loaded.retry}>Retry</button></section>;
  if (!state) return <section className="settings-card"><h3>Inertia Private Connect</h3><p>Loading Private Connect…</p></section>;
  const update = async (operation: () => Promise<PrivateConnectStateView>, success: string): Promise<void> => {
    setBusy(true); setMessage(null);
    try { setState(await operation()); setMessage(success); } catch (error) { setMessage(error instanceof Error ? error.message : "Private Connect could not be updated."); } finally { setBusy(false); }
  };
  const createInvitation = () => update(() => window.inertia.createPrivateConnectInvitation().then((invitation) => { setMessage(`Pairing link ready until ${new Date(invitation.expiresAt).toLocaleTimeString()}.`); return window.inertia.getPrivateConnectState(); }), "Pairing link ready.");
  const copyInvitation = async (): Promise<void> => {
    if (!state.invitation) return;
    try { await navigator.clipboard.writeText(state.invitation.url); setMessage("Pairing link copied."); } catch { setMessage("Copy failed. Select the link and copy it manually."); }
  };
  return <div className="settings-stack"><section className="settings-card" aria-labelledby="private-connect-heading"><div className="settings-card-heading"><div><span className={`status-dot ${state.status}`} /></div><span><h3 id="private-connect-heading">Inertia Private Connect</h3><p>Use your own Tailscale tailnet to open this online computer on another device.</p></span></div><div className="settings-rows"><div className="settings-row"><span><strong>Status</strong><small>{statusLabel(state)}</small></span><button type="button" disabled={busy || !state.available} onClick={() => void update(() => window.inertia.setPrivateConnectEnabled({ enabled: !state.enabled }), state.enabled ? "Private Connect disabled." : "Private Connect ready.")}>{state.enabled ? "Disable" : "Enable"}</button></div><div className="settings-row"><span><strong>Open on another device</strong><small>{state.externalUrl ?? "Enable Private Connect to create a private link."}</small></span><button type="button" disabled={busy || state.status !== "ready"} onClick={() => void createInvitation()}>Create pairing link</button></div></div>{state.status === "error" && <p className="settings-card-note">{state.statusMessage ?? "Private Connect could not be established safely."}</p>}{state.diagnostics.setupUrl && <button type="button" className="secondary-button" onClick={() => void window.inertia.openExternal(state.diagnostics.setupUrl!)}>Finish Tailscale setup</button>}{state.notice && <p className="settings-card-note">{state.notice}</p>}{message && <p className="settings-card-note">{message}</p>}</section>{state.invitation && <section className="settings-card" aria-labelledby="pairing-link-heading"><div className="settings-card-heading"><div>QR</div><span><h3 id="pairing-link-heading">Pair a browser</h3><p>This link expires in five minutes and is safe to share only with a device on your tailnet.</p></span></div>{qr && <img className="private-connect-qr" src={qr} alt="Short-lived Private Connect pairing QR code" />}<div className="settings-actions"><input aria-label="Private Connect pairing link" value={state.invitation.url} readOnly /><button type="button" onClick={() => void copyInvitation()}>Copy link</button></div></section>}<section className="settings-card" aria-labelledby="paired-devices-heading"><div className="settings-card-heading"><div>●</div><span><h3 id="paired-devices-heading">Paired devices</h3><p>Monitor is read-only. Collaborate can prompt, answer non-secret questions, and stop an active run.</p></span></div>{state.devices.length === 0 ? <p className="settings-card-note">No browsers are paired.</p> : <div className="settings-rows">{state.devices.map((device) => <div className="settings-row" key={device.id}><span><strong>{device.label}</strong><small>{device.preset} · {device.projectIds.length} project{device.projectIds.length === 1 ? "" : "s"} · expires {new Date(device.expiresAt).toLocaleDateString()}</small></span><button type="button" disabled={busy} onClick={() => void update(() => window.inertia.revokePrivateConnectDevice(device.id), "Device revoked.")}>Revoke</button></div>)}</div>}</section>{state.pendingPairings.map((pending) => { const selected = projectSelections[pending.requestId] ?? []; return <section className="settings-card pairing-approval" key={pending.requestId} aria-labelledby={`pairing-${pending.requestId}`}><h3 id={`pairing-${pending.requestId}`}>{pending.deviceLabel} wants to connect</h3><p>Comparison code: <strong className="private-connect-code">{pending.comparisonCode}</strong></p><p className="settings-card-note">Network metadata: {pending.tailnetLabel ?? "not available"}</p><fieldset><legend>Projects this device may access</legend>{projects.length === 0 ? <p className="settings-card-note">No projects are available to share.</p> : projects.map((project) => <label key={project.id}><input type="checkbox" checked={selected.includes(project.id)} onChange={() => setProjectSelections((current) => ({ ...current, [pending.requestId]: selected.includes(project.id) ? selected.filter((id) => id !== project.id) : [...selected, project.id] }))} /> {project.name}</label>)}</fieldset><div className="settings-actions"><button type="button" disabled={busy || selected.length === 0} onClick={() => void update(() => window.inertia.approvePrivateConnectPairing({ requestId: pending.requestId, preset: "monitor", projectIds: selected, grantDays: 30 }), "Monitor access approved.")}>Allow Monitor</button><button type="button" disabled={busy || selected.length === 0} onClick={() => void update(() => window.inertia.approvePrivateConnectPairing({ requestId: pending.requestId, preset: "collaborate", projectIds: selected, grantDays: 30 }), "Collaborate access approved.")}>Allow Collaborate</button><button type="button" disabled={busy} onClick={() => void update(() => window.inertia.denyPrivateConnectPairing(pending.requestId), "Pairing denied.")}>Deny</button></div></section>; })}</div>;
}

function statusLabel(state: PrivateConnectStateView): string {
  if (state.statusMessage) return state.statusMessage;
  if (state.status === "ready") return `${state.activeSessions} connected browser${state.activeSessions === 1 ? "" : "s"}`;
  if (state.status === "starting") return "Starting…";
  return "Off";
}
