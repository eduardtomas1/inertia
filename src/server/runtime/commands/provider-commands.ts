import type WebSocket from "ws";

import type {
  AppSnapshot,
  ProviderInfo,
  ServerEvent,
} from "../../../shared/contracts";
import type { ProviderMaintenanceController } from "../../provider/maintenance-controller";
import type { ProviderManager } from "../../providers";
import { PROVIDER_IDS } from "../../providers";
import type { TerminalManager } from "../../terminal";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface ProviderCommandDependencies {
  providers: ProviderManager;
  providerMaintenance: ProviderMaintenanceController;
  terminals: TerminalManager;
  defaultWorkspacePath: string;
  currentSnapshot(): AppSnapshot;
  refreshProviderInfo(
    providerId?: ProviderInfo["id"],
    refreshEnvironment?: boolean,
    forceMetadata?: boolean,
  ): Promise<void>;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createProviderCommandHandler(
  dependencies: ProviderCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "app.refresh",
    "provider.refresh",
    "provider.auth.start",
    "provider.maintenance.refresh",
    "provider.maintenance.update",
    "provider.maintenance.cancel",
  ], async (socket, command) => {
    switch (command.type) {
      case "app.refresh":
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        dependencies.send(socket, {
          type: "snapshot.updated",
          snapshot: dependencies.currentSnapshot(),
        });
        return "handled";
      case "provider.refresh":
        await dependencies.refreshProviderInfo(
          command.payload.providerId,
          true,
          true,
        );
        await dependencies.providerMaintenance.refresh(
          command.payload.providerId
            ? [command.payload.providerId]
            : PROVIDER_IDS,
          true,
        );
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      case "provider.auth.start": {
        const launch = await dependencies.providers.authLaunch(
          command.payload.providerId,
        );
        const terminalId = dependencies.terminals.createProcess(
          socket,
          dependencies.defaultWorkspacePath,
          launch.executable,
          launch.args,
          launch.env,
          command.payload.cols,
          command.payload.rows,
          () => {
            void dependencies.refreshProviderInfo(
              command.payload.providerId,
              true,
              true,
            ).catch(() => undefined);
          },
          undefined,
          launch.installationUse,
        );
        dependencies.send(socket, {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId,
        });
        return "handled";
      }
      case "provider.maintenance.refresh": {
        const statuses = await dependencies.providerMaintenance.refresh(
          command.payload.providerId
            ? [command.payload.providerId]
            : PROVIDER_IDS,
          command.payload.force === true,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "provider.maintenance", providers: statuses },
        });
        return "handled";
      }
      case "provider.maintenance.update": {
        const operation = await dependencies.providerMaintenance.startUpdate(
          command.payload.providerId,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "provider.maintenance.operation", operation },
        });
        return "handled";
      }
      case "provider.maintenance.cancel": {
        const operation = dependencies.providerMaintenance.cancel(
          command.payload.operationId,
        );
        if (!operation) {
          throw new RuntimeRequestError(
            "That provider update is no longer available.",
          );
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "provider.maintenance.operation", operation },
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
