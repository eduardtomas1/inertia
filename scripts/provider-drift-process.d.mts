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

export interface ProviderAcpProbeDependencies {
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputChars?: number;
}

export interface ProviderAcpHandshakeDependencies extends ProviderAcpProbeDependencies {
  spawn?(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ProviderAcpProcess;
}

export interface ProviderAcpInitializeValidation {
  advertiseCompaction?: boolean;
  allowSessionCapabilitiesResume?: boolean;
  expectedAgent: string;
  requireLoadSession: boolean;
}

export function processIsTerminal(child: ProviderProcessLifecycle): boolean;

export function confirmProviderProcessTermination(
  child: ProviderProcessLifecycle,
  timeoutMs?: number,
): Promise<boolean>;

export function runAcpInitializeHandshake(
  command: string,
  args: readonly string[],
  options: ProviderAcpHandshakeOptions,
  validation: ProviderAcpInitializeValidation,
  dependencies?: ProviderAcpHandshakeDependencies,
): Promise<void>;

export function requireAcpInitializeHandshake(
  command: string,
  args: readonly string[],
  options: ProviderAcpHandshakeOptions,
  validation: ProviderAcpInitializeValidation,
  dependencies?: ProviderAcpProbeDependencies,
): Promise<void>;
