import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

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
  stateDirectory?: string;
  initializeState?: boolean;
  allowLegacyRegistration?: boolean;
  maxEndpoints?: number;
  maxChallenges?: number;
  maxIpFailures?: number;
  maxEndpointFailures?: number;
  maxRateKeys?: number;
  now?: () => number;
}): Promise<ReferenceRelay>;
