import { randomUUID } from "node:crypto";

import { RuntimeRequestError } from "../runtime-errors";
import type {
  RuntimeSecureFileBroker,
  SecureFileRootCapability,
} from "../secure-files";

const DEFAULT_AUTHORITY_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_AUTHORITIES = 512;

export type SecureFileAuthorityPurpose =
  | "git-diff"
  | "reversal-apply"
  | "reversal-undo"
  | "workspace-save";

interface SecureFileAuthority {
  owner: object;
  purpose: SecureFileAuthorityPurpose;
  binding: readonly string[];
  root: SecureFileRootCapability;
  expiresAt: number;
}

export interface SecureFileAuthorityRegistryOptions {
  maxAuthorities?: number;
  ttlMs?: number;
  now?: () => number;
}

function sameBinding(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailableAuthority(): RuntimeRequestError {
  return new RuntimeRequestError(
    "This filesystem authorization expired or no longer matches the request. Refresh and try again.",
  );
}

/**
 * Keeps filesystem identities in the trusted runtime. Renderer-visible UUIDs
 * are only bounded lookup references and never encode a path or inode claim.
 */
export class SecureFileAuthorityRegistry {
  private readonly authorities = new Map<string, SecureFileAuthority>();
  private readonly maxAuthorities: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly secureFiles: RuntimeSecureFileBroker,
    options: SecureFileAuthorityRegistryOptions = {},
  ) {
    this.maxAuthorities = Math.max(
      1,
      Math.min(
        Math.trunc(options.maxAuthorities ?? DEFAULT_MAX_AUTHORITIES),
        4_096,
      ),
    );
    this.ttlMs = Math.max(
      1,
      Math.min(
        Math.trunc(options.ttlMs ?? DEFAULT_AUTHORITY_TTL_MS),
        DEFAULT_AUTHORITY_TTL_MS,
      ),
    );
    this.now = options.now ?? Date.now;
  }

  async issue(
    owner: object,
    purpose: SecureFileAuthorityPurpose,
    binding: readonly string[],
    root: SecureFileRootCapability,
  ): Promise<string> {
    await this.verify(root);
    this.prune();
    while (this.authorities.size >= this.maxAuthorities) {
      const oldest = this.authorities.keys().next().value;
      if (typeof oldest !== "string") break;
      this.authorities.delete(oldest);
    }
    let reference = randomUUID();
    while (this.authorities.has(reference)) reference = randomUUID();
    this.authorities.set(reference, {
      owner,
      purpose,
      binding: [...binding],
      root,
      expiresAt: this.now() + this.ttlMs,
    });
    return reference;
  }

  async resolve(
    owner: object,
    reference: string,
    purpose: SecureFileAuthorityPurpose,
    binding: readonly string[],
    options: { consume?: boolean } = {},
  ): Promise<SecureFileRootCapability> {
    this.prune();
    const authority = this.authorities.get(reference);
    if (
      !authority
      || authority.owner !== owner
      || authority.purpose !== purpose
      || !sameBinding(authority.binding, binding)
    ) {
      throw unavailableAuthority();
    }
    if (options.consume) this.authorities.delete(reference);
    try {
      await this.verify(authority.root);
      return authority.root;
    } catch (error) {
      this.authorities.delete(reference);
      throw error;
    }
  }

  clearOwner(owner: object): void {
    for (const [reference, authority] of this.authorities) {
      if (authority.owner === owner) this.authorities.delete(reference);
    }
  }

  clear(): void {
    this.authorities.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [reference, authority] of this.authorities) {
      if (authority.expiresAt <= now) this.authorities.delete(reference);
    }
  }

  private async verify(root: SecureFileRootCapability): Promise<void> {
    try {
      await this.secureFiles.verifyRoot(root);
    } catch {
      throw unavailableAuthority();
    }
  }
}
