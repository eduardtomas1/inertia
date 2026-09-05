import WebSocket from "ws";

import { sendTerminalSocketEvent } from "./terminal-socket";

const MAX_REATTACH_OUTPUT = 256 * 1024;
const OUTPUT_CHUNK_CODE_UNITS = 16 * 1024;
const TERMINAL_REATTACH_TRUNCATION_NOTICE =
  "\r\n\x1b[2mEarlier terminal output was truncated while reconnecting.\x1b[0m\r\n";

export interface TerminalOutputBuffer {
  queue(data: string): void;
  flush(): void;
  detach(): void;
  replay(owner: WebSocket): boolean;
  dispose(): void;
}

interface TerminalOutputBufferOptions {
  terminalId: string;
  retainHistory: boolean;
  flushMs: number;
  getDeliveryOwner(): WebSocket | null;
  hasAttachedOwner(): boolean;
  onDeliveryFailure(owner: WebSocket): void;
}

export function createTerminalOutputBuffer(
  options: TerminalOutputBufferOptions,
): TerminalOutputBuffer {
  let pendingOutput = "";
  const outputHistory: string[] = [];
  let outputHistoryLength = 0;
  let outputHistoryTruncated = false;
  let outputTimer: ReturnType<typeof setTimeout> | null = null;

  const sendOutput = (data: string): boolean => {
    const owner = options.getDeliveryOwner();
    if (!owner) return false;
    const sent = sendTerminalSocketEvent(owner, {
      type: "terminal.output",
      terminalId: options.terminalId,
      data,
    });
    if (!sent) options.onDeliveryFailure(owner);
    return sent;
  };
  const flush = (): void => {
    if (outputTimer) {
      clearTimeout(outputTimer);
      outputTimer = null;
    }
    while (pendingOutput.length > 0) {
      const data = pendingOutput.slice(0, OUTPUT_CHUNK_CODE_UNITS);
      pendingOutput = pendingOutput.slice(data.length);
      if (!sendOutput(data)) {
        pendingOutput = "";
        break;
      }
    }
  };
  const appendHistory = (data: string): void => {
    let remaining = data;
    if (remaining.length > MAX_REATTACH_OUTPUT) {
      remaining = remaining.slice(-MAX_REATTACH_OUTPUT);
      outputHistoryTruncated = true;
    }
    while (remaining.length > 0) {
      const lastIndex = outputHistory.length - 1;
      const last = outputHistory[lastIndex];
      const room = last === undefined
        ? 0
        : OUTPUT_CHUNK_CODE_UNITS - last.length;
      if (room > 0) {
        const addition = remaining.slice(0, room);
        outputHistory[lastIndex] = last + addition;
        outputHistoryLength += addition.length;
        remaining = remaining.slice(addition.length);
      } else {
        const addition = remaining.slice(0, OUTPUT_CHUNK_CODE_UNITS);
        outputHistory.push(addition);
        outputHistoryLength += addition.length;
        remaining = remaining.slice(addition.length);
      }
    }
    while (outputHistoryLength > MAX_REATTACH_OUTPUT) {
      const excess = outputHistoryLength - MAX_REATTACH_OUTPUT;
      const first = outputHistory[0];
      if (first.length <= excess) {
        outputHistory.shift();
        outputHistoryLength -= first.length;
      } else {
        outputHistory[0] = first.slice(excess);
        outputHistoryLength -= excess;
      }
      outputHistoryTruncated = true;
    }
  };
  const detach = (): void => {
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = null;
    pendingOutput = "";
  };

  return {
    queue(data) {
      if (options.retainHistory) appendHistory(data);
      if (!options.hasAttachedOwner()) return;
      pendingOutput += data;
      while (pendingOutput.length >= OUTPUT_CHUNK_CODE_UNITS) {
        const chunk = pendingOutput.slice(0, OUTPUT_CHUNK_CODE_UNITS);
        pendingOutput = pendingOutput.slice(OUTPUT_CHUNK_CODE_UNITS);
        if (!sendOutput(chunk)) {
          pendingOutput = "";
          return;
        }
      }
      if (pendingOutput.length > 0 && !outputTimer) {
        outputTimer = setTimeout(flush, options.flushMs);
        outputTimer.unref();
      }
    },
    flush,
    detach,
    replay(owner) {
      detach();
      const replay = outputHistoryTruncated
        ? [TERMINAL_REATTACH_TRUNCATION_NOTICE, ...outputHistory]
        : outputHistory;
      for (const data of replay) {
        if (!sendTerminalSocketEvent(owner, {
          type: "terminal.output",
          terminalId: options.terminalId,
          data,
        })) return false;
      }
      return true;
    },
    dispose() {
      if (options.hasAttachedOwner()) flush();
      else detach();
      outputHistory.length = 0;
      outputHistoryLength = 0;
      outputHistoryTruncated = false;
    },
  };
}
