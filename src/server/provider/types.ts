/**
 * Invoked once a provider confirms it has read/started executing an accepted
 * follow-up steer identified by `steerId`.
 */
export type ProviderSteerReadCallback = (steerId: string, readAt: string) => void;

declare module "./agent-harness" {
  interface AgentHarnessCallbacks {
    onSteerRead?: ProviderSteerReadCallback;
  }

  interface AgentHarnessStartOptions {
    onSteerRead?: ProviderSteerReadCallback;
  }
}
