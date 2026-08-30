export function terminalShutdownTimeoutMs(platform: NodeJS.Platform): number {
  // node-pty's Windows ConPTY backend intentionally delays its public exit
  // event for 1 second while output drains. Leave a second bounded interval
  // for a loaded host to deliver that signal and retire the durable process
  // claim before a runtime restart or database cleanup proceeds.
  if (platform === "win32") return 3_000;
  // The native macOS guardian can legitimately consume about 1.76 seconds in
  // its bounded worst case: two stable 16-pass freezes, a 5-poll TERM grace,
  // the post-KILL commit poll, and a 50-poll drain, all at 20 ms. Preserve
  // bounded scheduler/identity headroom, including one retry of the exact
  // guardian identity helper, instead of declaring that still-live proof
  // operation unsafe under host load. An outer runtime-shutdown deadline
  // remains authoritative and can tighten this.
  if (platform === "darwin") return 5_000;
  return 1_000;
}
