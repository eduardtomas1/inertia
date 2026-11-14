import { useState } from "react";
import type { ServerEvent } from "@shared/contracts";
import { usageSourceOrigin, usageSourceProfileId, type UsageLimitsSnapshot } from "@shared/provider-usage-limits";

import { resultEvent, type CommandWithoutId } from "../../lib/runtimeCommands";
import { plural } from "./limitText";

const MAX_USAGE_SOURCES = 4;

export function UsageSources({ snapshot, request, onChange, online }: {
  snapshot: UsageLimitsSnapshot | null;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onChange(): void;
  online: boolean;
}): React.JSX.Element {
  const [label, setLabel] = useState(""); const [url, setUrl] = useState(""); const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const sources = snapshot?.sources ?? [];
  const save = async (): Promise<void> => {
    const origin = usageSourceOrigin(url.trim());
    if (!origin) { setError("Use an HTTPS origin or HTTP on localhost, without a path or credentials."); return; }
    setBusy(true); setError(null);
    const id = crypto.randomUUID(); const profileId = usageSourceProfileId(id);
    let stored = false;
    try {
      const state = await window.inertia.setBackendCredential({ profileId, secret: key });
      if (!state.hasSecret || !state.storage.available) throw new Error();
      stored = true; setKey("");
      resultEvent(await request({ type: "usage.source.save", payload: { id, label: label.trim() || "CLIProxyAPI hub", url: origin, enabled: true } }));
      setLabel(""); setUrl(""); onChange();
    } catch {
      setError(stored ? "Hub save could not be confirmed. Refresh sources before trying again." : "The management key could not be saved in secure storage.");
      onChange();
    } finally { setBusy(false); }
  };
  const remove = async (id: string): Promise<void> => {
    setBusy(true); setError(null);
    try { resultEvent(await request({ type: "usage.source.remove", payload: { id } })); onChange(); }
    catch { setError("Hub removal could not be confirmed. Refresh to check."); }
    finally { setBusy(false); }
  };
  return (
    <details className="limits-sources">
      <summary>Usage sources <span>{plural(sources.length, "hub")}</span></summary>
      <p>CLIProxyAPI hubs add usage without changing agent routing. Keys stay in secure storage.</p>
      {sources.map((source) => (
        <div className="limits-source-row" key={source.id}>
          <span>
            <strong>{source.label}</strong>
            <small>{source.url} · {source.enabled ? "Enabled" : "Disabled"}</small>
            {source.error && <small role="status">{source.error}</small>}
          </span>
          <button type="button" className="secondary-button" disabled={busy || !online} onClick={() => void remove(source.id)}>Remove</button>
        </div>
      ))}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>Hub name<input value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} placeholder="Home hub" /></label>
        <label>Hub URL<input value={url} maxLength={2048} onChange={(event) => setUrl(event.target.value)} placeholder="https://hub.example.com" required /></label>
        <label>Management key<input type="password" value={key} maxLength={16384} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} required /></label>
        <button type="submit" className="secondary-button" disabled={busy || !online || !key || sources.length >= MAX_USAGE_SOURCES}>{busy ? "Saving…" : "Add hub"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
