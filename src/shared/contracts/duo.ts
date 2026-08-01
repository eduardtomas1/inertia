export const DUO_LAUNCH_STATES = [
  "preparing",
  "prepared",
  "dispatching",
  "running",
  "cancelled",
  "failed",
  "interrupted",
  "recovery-required",
] as const;

export type DuoLaunchState = typeof DUO_LAUNCH_STATES[number];

export const DUO_DISPATCH_STATES = [
  "pending",
  "claimed",
  "started",
  "failed",
  "cancelled",
  "uncertain",
] as const;

export type DuoDispatchState = typeof DUO_DISPATCH_STATES[number];

export interface DuoLaunchSideStatus {
  ordinal: 0 | 1;
  conversationId: string | null;
  turnId: string | null;
  dispatchState: DuoDispatchState;
}

export interface DuoLaunchStatus {
  launchId: string;
  state: DuoLaunchState;
  error: string | null;
  sides: [DuoLaunchSideStatus, DuoLaunchSideStatus];
}

export interface DuoPreparedSide {
  ordinal: 0 | 1;
  conversationId: string;
  turnId: string;
}

export interface DuoPreparedResult {
  kind: "duo.prepared";
  launchId: string;
  state: "prepared";
  sides: [DuoPreparedSide, DuoPreparedSide];
}

export type DuoStatusResult = DuoLaunchStatus & { kind: "duo.status" };
