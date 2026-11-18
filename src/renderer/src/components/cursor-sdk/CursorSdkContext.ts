import { createContext } from "react";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import type { ConnectionStatus } from "../../hooks/useInertiaConnection";

export interface CursorSdkTransport {
  status: ConnectionStatus;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}

export const CursorSdkContext = createContext<CursorSdkTransport | null>(null);
