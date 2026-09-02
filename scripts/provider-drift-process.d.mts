import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { SpawnOptions } from "node:child_process";

export interface ProviderProcessLifecycle extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ProviderAcpProcess extends ProviderProcessLifecycle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export interface ProviderAcpHandshakeOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export interface ProviderAcpHandshakeDependencies {
  spawn?(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ProviderAcpProcess;
  terminate?(child: ProviderProcessLifecycle): void;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputChars?: number;
}

export function processIsTerminal(child: ProviderProcessLifecycle): boolean;

export function terminateProviderProcess(
  child: ProviderProcessLifecycle,
): void;

export function confirmProviderProcessTermination(
  child: ProviderProcessLifecycle,
  terminate?: (child: ProviderProcessLifecycle) => void,
  timeoutMs?: number,
): Promise<boolean>;

export function requireAcpInitializeHandshake(
  command: string,
  args: readonly string[],
  options: ProviderAcpHandshakeOptions,
  expectedAgent: RegExp,
  dependencies?: ProviderAcpHandshakeDependencies,
): Promise<void>;
