export interface ProtocolRange {
  minimum: number;
  maximum: number;
}

export type RemoteComponentKind = "browser" | "desktop" | "relay";

export interface ComponentCompatibility {
  kind: RemoteComponentKind;
  version: string;
  relayProtocol: ProtocolRange;
  remoteProtocol: ProtocolRange;
}

export interface CompatibilityGuidance {
  action: "upgrade" | "downgrade";
  component: RemoteComponentKind;
  requiredProtocol: ProtocolRange;
}

export interface RemoteIncompatibility {
  type: "relay.incompatible";
  axis: "relay-protocol" | "remote-protocol";
  reason:
    | "client-too-old"
    | "client-too-new"
    | "relay-too-old"
    | "relay-too-new";
  component: RemoteComponentKind;
  received: ProtocolRange;
  supported: ProtocolRange;
  guidance: CompatibilityGuidance[];
}

export const RELAY_PROTOCOL_RANGE: Readonly<ProtocolRange>;
export const REMOTE_PROTOCOL_RANGE: Readonly<ProtocolRange>;

export function highestIntersection(ranges: ProtocolRange[]): number | null;
export function negotiateCompatibility(input: {
  relay: ComponentCompatibility & { kind: "relay" };
  desktop: ComponentCompatibility & { kind: "desktop" };
  browser: ComponentCompatibility & { kind: "browser" };
}):
  | {
      ok: true;
      selected: {
        relayProtocol: number;
        remoteProtocol: number;
      };
      versions: {
        relay: string;
        desktop: string;
        browser: string;
      };
    }
  | { ok: false; incompatibility: RemoteIncompatibility };
