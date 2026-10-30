import { useContext, useEffect, useRef, useState } from "react";
import { CursorSdkContext } from "./CursorSdkContext";
import { cursorSdkModelRoute } from "./cursorSdkModelRoute";
import type { ComposerModelRoute } from "../../utils/modelChooserRoutes";
import "./CursorSdkAccount.css";

export function CursorSdkModels({ onSelect, query }: {
  onSelect: (route: ComposerModelRoute) => void;
  query: string;
}) {
  const transport = useContext(CursorSdkContext);
  const [routes, setRoutes] = useState<ComposerModelRoute[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const online = transport?.status === "online";
  useEffect(() => {
    generation.current += 1;
    setRoutes([]);
    pending.current = false;
    setLoading(false);
    return () => { generation.current += 1; };
  }, [online]);
  if (!transport) return null;

  const load = async () => {
    if (!online || pending.current) return;
    pending.current = true;
    const current = ++generation.current;
    setLoading(true);
    setRoutes([]);
    setMessage(null);
    try {
      const requestId = crypto.randomUUID();
      const status = await transport.sendCommand({ type: "provider.cursor-sdk.status", requestId });
      if (current !== generation.current) return;
      if (status.type !== "request.result" || status.requestId !== requestId
        || status.result.kind !== "provider.cursor-sdk.status") throw new Error();
      if (!status.result.available) {
        setMessage("Cursor SDK is unavailable in this installation.");
        return;
      }
      if (!status.result.hasCredential) {
        setMessage("Sign in with Cursor SDK in Accounts and API keys first.");
        return;
      }
      const modelsRequestId = crypto.randomUUID();
      const result = await transport.sendCommand({ type: "provider.cursor-sdk.models", requestId: modelsRequestId });
      if (current !== generation.current) return;
      if (result.type !== "request.result" || result.requestId !== modelsRequestId
        || result.result.kind !== "provider.cursor-sdk.models") throw new Error();
      const discovered = result.result.models.flatMap((model) => {
        const route = cursorSdkModelRoute(model);
        return route ? [route] : [];
      });
      setRoutes(discovered);
      if (discovered.length === 0) setMessage("Cursor SDK reported no concrete models.");
    } catch {
      if (current === generation.current) setMessage("Could not load Cursor SDK models. Check SDK sign-in in Accounts and API keys, then retry.");
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  const matching = routes.filter((route) => `${route.displayName} ${route.modelId} Cursor SDK`.toLowerCase().includes(query.toLowerCase().trim()));
  return (
    <section className="cursor-sdk-models" aria-label="Cursor SDK models" onKeyDown={(event) => event.stopPropagation()}>
      <button type="button" className="text-button" disabled={!online || loading} onClick={() => void load()}>
        {loading ? "Loading Cursor SDK models…" : "Load Cursor SDK models"}
      </button>
      {message && <p role="status">{message}</p>}
      {matching.length > 0 && <ul aria-label="Discovered Cursor SDK models">
        {matching.map((route) => (
          <li key={route.key}>
            <button type="button" className="secondary-button" disabled={!online || !route.selectable} onClick={() => onSelect(route)}>
              {route.displayName} · Cursor SDK
            </button>
          </li>
        ))}
      </ul>}
    </section>
  );
}
