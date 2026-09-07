/// <reference types="vite/client" />

import { Profiler } from "react";
import { createRoot } from "react-dom/client";

import type { SubagentTrace } from "../../../src/shared/contracts";
import { SubagentElapsed } from "../../../src/renderer/src/components/SubagentElapsed";
import "../../../src/renderer/src/components/composer/ComposerSendActions.css";
import { useDocumentPresence } from "../../../src/renderer/src/hooks/useDocumentPresence";

export interface NativeMotionCounters { commits: number; frames: number; ticks: number; timers: number }

declare global {
  interface Window {
    nativeMotion: NativeMotionCounters;
  }
}

const counters = window.nativeMotion = { commits: 0, frames: 0, ticks: 0, timers: 0 };
const timers = new Set<number>();
const interval = window.setInterval.bind(window);
Object.assign(window, { setInterval: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
  const id = interval(() => {
    counters.ticks++;
    if (typeof handler === "function") handler(...args);
    else throw new Error("The native motion fixture expects callback timers.");
  }, delay);
  timers.add(id);
  counters.timers = timers.size;
  return id;
} });
const clearInterval = window.clearInterval.bind(window);
Object.assign(window, { clearInterval: (id?: number) => {
  if (id !== undefined) timers.delete(id);
  counters.timers = timers.size;
  clearInterval(id);
} });
const frame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) => frame((time) => { counters.frames++; callback(time); });
const startedAt = new Date().toISOString();
const trace: SubagentTrace = {
  id: "native-motion", conversationId: "conversation", runId: "run", turnId: "turn",
  providerId: "codex", providerTaskId: "task", providerAgentId: "agent",
  parentTraceId: null, parentProviderAgentId: null, parentProviderToolUseId: null,
  providerToolUseId: null, providerRole: null, providerName: "Fixture worker",
  providerStatus: "running", status: "running", isLive: true,
  description: "Native motion", progress: null, result: null, sequence: 1,
  createdAt: startedAt, updatedAt: startedAt,
};

function Motion(): React.JSX.Element {
  useDocumentPresence();
  return <>
    <button className="send-button" data-motion-state="sending">
      <span className="composer-send-motion-icon" style={{ display: "inline-block" }}>Progress</span>
    </button>
    <output><SubagentElapsed trace={trace} /></output>
  </>;
}

createRoot(document.getElementById("root")!).render(
  <Profiler id="native-motion" onRender={() => { counters.commits++; }}><Motion /></Profiler>,
);
