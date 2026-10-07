import type { SecureFileIdentity } from "../node/secure-file-protocol";

export interface SecureFileRead {
  content: Buffer;
  digest: string;
  size: number;
  modifiedAt: string;
  mode: number;
}

export interface SecureFileReplace {
  digest: string;
  size: number;
  modifiedAt: string;
  mode: number;
}

export type SecureFileErrorCode =
  | "conflict"
  | "invalid"
  | "not-found"
  | "too-large"
  | "unsafe"
  | "unavailable";

export class SecureFileError extends Error {
  constructor(
    readonly code: SecureFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecureFileError";
  }
}

export interface SecureFileRootCapability {
  root: string;
  identity: SecureFileIdentity;
  /** Directory creation identity, "0" when the filesystem reports none; kept outside renderer contracts. */
  birthtimeNs: string;
}

export interface RuntimeSecureFileBroker {
  authorizeRoot(
    root: string,
    signal?: AbortSignal,
  ): Promise<SecureFileRootCapability>;
  verifyRoot(
    root: SecureFileRootCapability,
    signal?: AbortSignal,
  ): Promise<void>;
  read(
    root: SecureFileRootCapability,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileRead>;
  replace(
    root: SecureFileRootCapability,
    path: string,
    content: Buffer,
    expectedDigest: string,
    expectedMode: number,
    mode: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileReplace>;
}

async function unavailableSecureFiles(): Promise<never> {
  throw new SecureFileError(
    "unavailable",
    "Secure workspace file access is unavailable.",
  );
}

export const unavailableSecureFileBroker: RuntimeSecureFileBroker = {
  authorizeRoot: unavailableSecureFiles,
  verifyRoot: unavailableSecureFiles,
  read: unavailableSecureFiles,
  replace: unavailableSecureFiles,
};
