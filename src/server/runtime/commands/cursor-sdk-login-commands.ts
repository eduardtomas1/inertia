import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import { isCursorSdkLoginUrl, type CursorSdkLoginState } from "../../../shared/cursor-sdk-auth";
import { RuntimeRequestError } from "../../runtime-errors";
import { isProcessTreeTerminationUnconfirmed } from "../../process-lifecycle";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";
import { CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE, CursorSdkAccountProbes, type CursorSdkAccountProbeDependencies } from "./cursor-sdk-account-probes";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_RECENT_LOGINS = 16;

interface CursorSdkLoginCommandDependencies extends CursorSdkAccountProbeDependencies {
  enabled: boolean;
  login(onUrl: (url: string) => void, signal: AbortSignal): Promise<{ expiresAt: number }>;
  send(socket: WebSocket, event: ServerEvent): void;
}

interface LoginOperation {
  socket: WebSocket;
  requestId: string;
  controller: AbortController;
  state: CursorSdkLoginState;
  stopped?: "cancelled" | "expired" | "failed";
  disconnected: boolean;
  cleanupUnconfirmed?: boolean;
}

export function createCursorSdkLoginCommandHandler(
  dependencies: CursorSdkLoginCommandDependencies,
): RuntimeCommandHandler {
  let active: LoginOperation | undefined;
  const probes = new CursorSdkAccountProbes(dependencies);
  const recent = new WeakMap<WebSocket, Map<string, CursorSdkLoginState>>();
  const publish = (operation: LoginOperation, state: CursorSdkLoginState): void => {
    operation.state = state;
    if (!operation.disconnected && operation.socket.readyState === 1) {
      dependencies.send(operation.socket, {
        type: "provider.cursor-sdk.login.updated",
        loginRequestId: operation.requestId,
        ...state,
      });
    }
  };
  const stop = (operation: LoginOperation, reason: LoginOperation["stopped"]): void => {
    if (operation.controller.signal.aborted || operation.cleanupUnconfirmed) return;
    operation.stopped = reason;
    publish(operation, { status: "cancelling" });
    operation.controller.abort();
  };
  const acknowledge = (socket: WebSocket, requestId: string): void => {
    dependencies.send(socket, { type: "request.ok", requestId });
  };

  return defineRuntimeCommandHandler([
    "provider.cursor-sdk.status",
    "provider.cursor-sdk.models",
    "provider.cursor-sdk.login",
    "provider.cursor-sdk.login.cancel",
  ], async (socket, command, authority) => {
    if (command.type !== "provider.cursor-sdk.login" && command.type !== "provider.cursor-sdk.login.cancel"
      && command.type !== "provider.cursor-sdk.status" && command.type !== "provider.cursor-sdk.models") {
      return "not-handled";
    }
    if (authority && authority.kind !== "main") {
      throw new RuntimeRequestError("Connect Cursor SDK from the main window.");
    }
    if (command.type === "provider.cursor-sdk.login.cancel") {
      const target = command.payload.loginRequestId;
      if (active?.socket === socket && active.requestId === target) {
        if (active.cleanupUnconfirmed) {
          throw new RuntimeRequestError(CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE);
        }
        stop(active, "cancelled");
      } else if (!recent.get(socket)?.has(target)) {
        throw new RuntimeRequestError("That Cursor SDK sign-in is no longer available in this window.");
      }
      acknowledge(socket, command.requestId);
      return "handled";
    }
    if (!dependencies.enabled || dependencies.signal.aborted || socket.readyState !== 1) {
      throw new RuntimeRequestError("Cursor SDK sign-in is currently unavailable.");
    }
    if (probes.cleanupUnconfirmed || active?.cleanupUnconfirmed
      && (command.type !== "provider.cursor-sdk.login" || active.socket !== socket || active.requestId !== command.requestId)) {
      throw new RuntimeRequestError(CURSOR_SDK_CLEANUP_UNCONFIRMED_MESSAGE);
    }
    if (command.type === "provider.cursor-sdk.status" || command.type === "provider.cursor-sdk.models") {
      if (active) throw new RuntimeRequestError("Wait for the current Cursor SDK sign-in to finish.");
      const result = await probes.read(command.type === "provider.cursor-sdk.status" ? "status" : "models");
      if (socket.readyState === 1 && !dependencies.signal.aborted) dependencies.send(socket, {
        type: "request.result", requestId: command.requestId, result,
      });
      return "handled";
    }
    if (probes.pending) throw new RuntimeRequestError("Wait for the Cursor SDK availability check to finish.");
    const previous = recent.get(socket)?.get(command.requestId);
    if (previous) {
      acknowledge(socket, command.requestId);
      dependencies.send(socket, {
        type: "provider.cursor-sdk.login.updated", loginRequestId: command.requestId, ...previous,
      });
      return "handled";
    }
    if (active) {
      if (active.socket !== socket || active.requestId !== command.requestId) {
        throw new RuntimeRequestError("Another Cursor SDK sign-in is still active. Finish or cancel it first.");
      }
      acknowledge(socket, command.requestId);
      publish(active, active.state);
      return "handled";
    }
    const operation: LoginOperation = {
      socket, requestId: command.requestId, controller: new AbortController(),
      state: { status: "starting" }, disconnected: false,
    };
    active = operation;
    const onClose = (): void => { operation.disconnected = true; stop(operation, "cancelled"); };
    const onShutdown = (): void => stop(operation, "cancelled");
    socket.once("close", onClose);
    dependencies.signal.addEventListener("abort", onShutdown, { once: true });
    const deadline = setTimeout(() => stop(operation, "expired"), LOGIN_TIMEOUT_MS);
    deadline.unref();
    const release = (): void => {
      clearTimeout(deadline);
      socket.removeListener("close", onClose);
      dependencies.signal.removeEventListener("abort", onShutdown);
      if (active !== operation || operation.cleanupUnconfirmed) return;
      active = undefined;
      const history = recent.get(socket) ?? new Map<string, CursorSdkLoginState>();
      history.set(operation.requestId, operation.state);
      while (history.size > MAX_RECENT_LOGINS) history.delete(history.keys().next().value!);
      recent.set(socket, history);
    };
    acknowledge(socket, command.requestId);
    publish(operation, operation.state);
    void Promise.resolve().then(() => dependencies.track(async () => {
      try {
        operation.controller.signal.throwIfAborted();
        const result = await dependencies.login((loginUrl) => {
          operation.controller.signal.throwIfAborted();
          if (!isCursorSdkLoginUrl(loginUrl)) {
            stop(operation, "failed");
            throw new Error("Cursor SDK sign-in returned an invalid URL.");
          }
          publish(operation, { status: "waiting", loginUrl });
        }, operation.controller.signal);
        if (!Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) {
          throw new Error("Cursor SDK sign-in returned an invalid expiry.");
        }
        publish(operation, operation.stopped
          ? { status: operation.stopped }
          : { status: "authenticated", expiresAt: result.expiresAt });
      } catch (error) {
        operation.cleanupUnconfirmed = isProcessTreeTerminationUnconfirmed(error);
        publish(operation, { status: operation.stopped ?? "failed" });
      } finally {
        release();
      }
    })).catch((error: unknown) => {
      operation.cleanupUnconfirmed ||= isProcessTreeTerminationUnconfirmed(error);
      publish(operation, { status: operation.stopped ?? "failed" });
      release();
    });
    return "handled";
  });
}
