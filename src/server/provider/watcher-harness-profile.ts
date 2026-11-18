export interface WatcherHarnessProfile {
  systemInstruction: boolean;
  sessionInstruction: boolean;
  sessionInstructionRecordedAtCompaction: boolean;
  editsGatedBeforeStart: boolean;
}

const UNKNOWN_HARNESS: WatcherHarnessProfile = Object.freeze({
  systemInstruction: false,
  sessionInstruction: false,
  sessionInstructionRecordedAtCompaction: false,
  editsGatedBeforeStart: false,
});

const HARNESS_PROFILES: Readonly<Record<string, WatcherHarnessProfile>> = Object.freeze({
  "pi-rpc": Object.freeze({ systemInstruction: true, sessionInstruction: true, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: true }),
  "claude-agent-sdk": Object.freeze({ systemInstruction: true, sessionInstruction: true, sessionInstructionRecordedAtCompaction: true, editsGatedBeforeStart: true }),
  "codex-app-server": Object.freeze({ systemInstruction: true, sessionInstruction: true, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: true }),
  "opencode-sdk": Object.freeze({ systemInstruction: true, sessionInstruction: false, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: false }),
  "cursor-sdk": Object.freeze({ systemInstruction: false, sessionInstruction: false, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: true }),
  "cursor-acp": Object.freeze({ systemInstruction: false, sessionInstruction: false, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: true }),
  "kimi-acp": Object.freeze({ systemInstruction: false, sessionInstruction: false, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: true }),
  "antigravity-cli": Object.freeze({ systemInstruction: false, sessionInstruction: false, sessionInstructionRecordedAtCompaction: false, editsGatedBeforeStart: false }),
});

export function watcherHarnessProfile(harnessId: string): WatcherHarnessProfile {
  return Object.hasOwn(HARNESS_PROFILES, harnessId) ? HARNESS_PROFILES[harnessId]! : UNKNOWN_HARNESS;
}

export const MAX_SYSTEM_INSTRUCTION_BYTES = 16 * 1_024;
