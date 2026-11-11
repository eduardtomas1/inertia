import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { UsagePriceList } from "../../usage/price-list-service";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface UsageCommandDependencies {
  store: RuntimeStore;
  priceList?: Pick<UsagePriceList, "ensure">;
  send(socket: WebSocket, event: ServerEvent): void;
}

const FIRST_PRICE_LIST_WAIT_MS = 4_000;

export function createUsageCommandHandler(
  dependencies: UsageCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(
    ["usage.dashboard.get", "daily.work.get"],
    async (socket, command) => {
      if (command.type === "daily.work.get") {
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "daily.work",
            dashboard: dependencies.store.dailyWork(command.payload),
          },
        });
        return "handled";
      }
      if (command.type !== "usage.dashboard.get") return "not-handled";
      dependencies.send(socket, {
        type: "request.result",
        requestId: command.requestId,
        result: {
          kind: "usage.dashboard",
          dashboard: dependencies.store.usageDashboard(
            command.payload,
            await dependencies.priceList?.ensure(FIRST_PRICE_LIST_WAIT_MS),
          ),
        },
      });
      return "handled";
    },
  );
}
