export interface WatcherHarnessProfile {
  systemInstruction: boolean;
  editsGatedBeforeStart: boolean;
}

const UNKNOWN_HARNESS: WatcherHarnessProfile = Object.freeze({
  systemInstruction: false,
  editsGatedBeforeStart: false,
});

const HARNESS_PROFILES: Readonly<Record<string, WatcherHarnessProfile>> = Object.freeze({
  "claude-agent-sdk": Object.freeze({ systemInstruction: true, editsGatedBeforeStart: true }),
  "codex-app-server": Object.freeze({ systemInstruction: true, editsGatedBeforeStart: true }),
  "opencode-sdk": Object.freeze({ systemInstruction: true, editsGatedBeforeStart: false }),
  "cursor-acp": Object.freeze({ systemInstruction: false, editsGatedBeforeStart: true }),
  "kimi-acp": Object.freeze({ systemInstruction: false, editsGatedBeforeStart: true }),
  "antigravity-cli": Object.freeze({ systemInstruction: false, editsGatedBeforeStart: false }),
});

export function watcherHarnessProfile(harnessId: string): WatcherHarnessProfile {
  return Object.hasOwn(HARNESS_PROFILES, harnessId) ? HARNESS_PROFILES[harnessId]! : UNKNOWN_HARNESS;
}

export const MAX_SYSTEM_INSTRUCTION_BYTES = 16 * 1_024;
