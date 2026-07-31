import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

export interface ReferenceRelay {
  server: Server;
  address(): AddressInfo | null;
  close(): Promise<void>;
}

export function createReferenceRelay(options?: {
  host?: string;
  port?: number;
  maxConnections?: number;
  maxConnectionsPerDesktop?: number;
  maxBufferedBytes?: number;
  allowedOrigins?: string[];
  now?: () => number;
}): Promise<ReferenceRelay>;
