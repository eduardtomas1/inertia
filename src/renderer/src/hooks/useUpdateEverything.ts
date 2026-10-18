import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
  ServerEvent,
} from "@shared/contracts";
import type { AppUpdateStatus } from "@shared/desktop";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { UpdateEverythingPhase, UpdateEverythingRequest } from "../utils/updateEverythingRun";

export interface UpdateEverythingController {
  statuses: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceStatus>;
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  phase: UpdateEverythingPhase | null;
  error: string | null;
  run: (request: UpdateEverythingRequest, providerLabels: ReadonlyMap<ProviderMaintenanceProviderId, string>) => Promise<void>;
  dismissError: () => void;
}

export function useUpdateEverything({ statuses, operations, appStatus, request }: {
  statuses: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceStatus>;
  operations: ReadonlyMap<ProviderMaintenanceProviderId, ProviderMaintenanceOperation>;
  appStatus: AppUpdateStatus | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}): UpdateEverythingController {
  const [phase, setPhase] = useState<UpdateEverythingPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const appStatusRef = useRef(appStatus);
  useEffect(() => { appStatusRef.current = appStatus; }, [appStatus]);

  const run = useCallback(async (
    payload: UpdateEverythingRequest,
    providerLabels: ReadonlyMap<ProviderMaintenanceProviderId, string>,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setPhase(payload.includeApp && appStatusRef.current?.state === "available"
      ? { kind: "download" } : { kind: "providers", providerIds: payload.providerIds });
    try {
      const { runUpdateEverything } = await import("../utils/updateEverythingRun");
      setError(await runUpdateEverything({
        payload,
        request,
        appStatus: () => appStatusRef.current,
        providerLabels,
        onPhase: setPhase,
      }));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "The update could not be completed.");
    } finally {
      inFlight.current = false;
      setPhase(null);
    }
  }, [request]);
  const dismissError = useCallback(() => setError(null), []);
  return { statuses, operations, phase, error, run, dismissError };
}
