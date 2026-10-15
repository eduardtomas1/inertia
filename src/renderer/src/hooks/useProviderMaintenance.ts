import { useCallback, useEffect, useState } from "react";

import type {
  AppSnapshot,
  ClientCommand,
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
  ProviderMaintenanceStatus,
  ServerEvent,
} from "@shared/contracts";
import {
  providerMaintenanceOperationMap,
} from "../utils/providerMaintenance";

type MaintenanceCommand = Extract<
  ClientCommand,
  {
    type:
      | "provider.maintenance.refresh"
      | "provider.maintenance.update"
      | "provider.maintenance.cancel";
  }
>;

type MaintenanceCommandWithoutId = MaintenanceCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export interface ProviderMaintenanceProjection {
  statuses: ReadonlyMap<
    ProviderMaintenanceProviderId,
    ProviderMaintenanceStatus
  >;
  operations: ReadonlyMap<
    ProviderMaintenanceProviderId,
    ProviderMaintenanceOperation
  >;
  refresh: (
    providerId?: ProviderMaintenanceProviderId,
    force?: boolean,
  ) => Promise<void>;
  update: (providerId: ProviderMaintenanceProviderId) => Promise<void>;
  cancel: (operationId: string) => Promise<void>;
}

function statusMap(
  providers: AppSnapshot["providers"] | undefined,
): Map<ProviderMaintenanceProviderId, ProviderMaintenanceStatus> {
  return new Map((providers ?? []).flatMap(({ maintenance }) =>
    maintenance ? [[maintenance.providerId, maintenance] as const] : []));
}

export function useProviderMaintenance(
  snapshot: AppSnapshot | null,
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>,
  subscribe: (listener: (event: ServerEvent) => void) => () => void,
): ProviderMaintenanceProjection {
  const snapshotProviders = snapshot?.providers;
  const snapshotOperations = snapshot?.maintenanceOperations;
  const [statuses, setStatuses] = useState(() => statusMap(snapshotProviders));
  const [operations, setOperations] = useState(
    () => providerMaintenanceOperationMap(snapshotOperations),
  );

  useEffect(() => {
    const fromSnapshot = statusMap(snapshotProviders);
    if (fromSnapshot.size === 0) return;
    setStatuses((current) => new Map([...current, ...fromSnapshot]));
  }, [snapshotProviders]);

  useEffect(() => {
    const fromSnapshot = providerMaintenanceOperationMap(snapshotOperations);
    if (fromSnapshot.size === 0) return;
    setOperations((current) => new Map([...current, ...fromSnapshot]));
  }, [snapshotOperations]);

  useEffect(() => subscribe((event) => {
    if (event.type === "server.welcome") {
      setStatuses(statusMap(event.snapshot.providers));
      setOperations(providerMaintenanceOperationMap(
        event.snapshot.maintenanceOperations,
      ));
      return;
    }
    if (event.type === "provider.maintenance.updated") {
      setStatuses((current) => new Map([
        ...current,
        ...event.providers.map((status) =>
          [status.providerId, status] as const),
      ]));
      return;
    }
    if (event.type === "provider.maintenance.operation") {
      setOperations((current) => new Map(current).set(
        event.operation.providerId,
        event.operation,
      ));
    }
  }), [subscribe]);

  const request = useCallback(async (
    command: MaintenanceCommandWithoutId,
  ): Promise<void> => {
    await sendCommand({
      ...command,
      requestId: crypto.randomUUID(),
    } as MaintenanceCommand);
  }, [sendCommand]);

  const refresh = useCallback(async (
    providerId?: ProviderMaintenanceProviderId,
    force = false,
  ): Promise<void> => {
    await request({
      type: "provider.maintenance.refresh",
      payload: {
        ...(providerId ? { providerId } : {}),
        ...(force ? { force: true } : {}),
      },
    });
  }, [request]);

  const update = useCallback(async (
    providerId: ProviderMaintenanceProviderId,
  ): Promise<void> => {
    await request({
      type: "provider.maintenance.update",
      payload: { providerId },
    });
  }, [request]);

  const cancel = useCallback(async (operationId: string): Promise<void> => {
    await request({
      type: "provider.maintenance.cancel",
      payload: { operationId },
    });
  }, [request]);

  return { statuses, operations, refresh, update, cancel };
}
