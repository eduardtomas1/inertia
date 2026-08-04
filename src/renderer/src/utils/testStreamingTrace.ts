export function markTestStreamingStage(stage: string): void {
  const trace = Reflect.get(globalThis, "__inertiaTestStreamingTrace");
  if (typeof trace === "function") trace(stage);
}
