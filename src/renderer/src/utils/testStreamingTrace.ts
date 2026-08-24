export const RENDERER_WORKSPACE_CONTENT_COMMITTED_STAGE =
  "renderer-workspace-content-committed";

export function markTestStreamingStage(stage: string): void {
  const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
  if (typeof trace === "function") trace(stage);
}
