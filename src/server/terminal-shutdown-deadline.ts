export function terminalShutdownTimeoutMs(platform: NodeJS.Platform): number {
  // node-pty's Windows ConPTY backend intentionally delays its public exit
  // event for 1 second while output drains. Leave bounded headroom for that
  // signal and the final resource-settle check.
  if (platform === "win32") return 1_500;
  // The native macOS guardian can legitimately consume about 1.76 seconds in
  // its bounded worst case: two stable 16-pass freezes, a 5-poll TERM grace,
  // the post-KILL commit poll, and a 50-poll drain, all at 20 ms. Preserve
  // bounded scheduler/identity headroom instead of declaring that still-live
  // proof operation unsafe at the former generic 1-second deadline. An outer
  // runtime-shutdown deadline remains authoritative and can tighten this.
  if (platform === "darwin") return 2_250;
  return 1_000;
}
