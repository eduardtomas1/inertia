import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { ProviderId } from "./contracts";

export const PROVIDER_INSTALLATION_USE_KINDS = [
  "provider-run",
  "provider-server",
  "metadata-discovery",
  "auth-discovery",
  "compatibility-probe",
  "isolation-proof",
  "drift-verification",
  "startup-recovery",
  "app-update-preparation",
  "runtime-shutdown",
] as const;

export type ProviderInstallationUseKind =
  (typeof PROVIDER_INSTALLATION_USE_KINDS)[number];

const PROVIDER_INSTALLATION_PACKAGES: Readonly<
  Record<ProviderId, string | null>
> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  cursor: null,
  gemini: "@google/gemini-cli",
  kimi: "@moonshot-ai/kimi-code",
  opencode: "opencode-ai",
};

export function providerInstallationPackageIdentity(
  providerId: ProviderId,
): string | null {
  return PROVIDER_INSTALLATION_PACKAGES[providerId];
}

/**
 * Internal, non-secret inputs used to identify one physical provider
 * installation. Raw paths and environment/profile values are reduced to
 * hashes before they can appear in blocker diagnostics.
 */
export interface ProviderInstallationCoordinates {
  providerId: ProviderId;
  /** Canonical resolved executable when one is available. */
  executable: string | null;
  /** Physical installation root used only when no executable is available. */
  installationRootIdentity: string | null;
  packageIdentity: string | null;
  version: string | null;
  directFileIdentity?: string | null;
  backendConfigurationIdentity?: string | null;
  profileIdentity?: string | null;
  environmentIdentity?: string | null;
  /** Stable caller-owned route alias which survives a symlink replacement. */
  replacementBoundaryIdentity?: string | null;
}

export interface ProviderInstallationIdentity {
  providerId: ProviderId;
  /** Stable replacement boundary. Contains no raw path or secret. */
  boundaryId: string;
  /** Stable physical-installation scope. Contains no raw path or secret. */
  scopeId: string;
  /** Exact observed version/file/configuration fingerprint. */
  fingerprint: string;
}

export interface ProviderInstallationUseOwner {
  kind: ProviderInstallationUseKind;
  /** Exact run/probe/recovery operation identity; never a prompt or command. */
  operationId: string;
}

export type ProviderInstallationBlockerKind =
  | ProviderInstallationUseKind
  | "maintenance-pending"
  | "maintenance-active"
  | "quarantined";

/** Renderer-safe blocker evidence. No executable path, argv, or environment. */
export interface ProviderInstallationBlocker {
  providerId: ProviderId;
  scopeId: string;
  kind: ProviderInstallationBlockerKind;
  operationId: string;
  fingerprintMatches: boolean;
  reason: string | null;
}

export class ProviderInstallationAdmissionError extends Error {
  readonly blockers: readonly ProviderInstallationBlocker[];

  constructor(
    message: string,
    blockers: readonly ProviderInstallationBlocker[],
  ) {
    super(message);
    this.name = "ProviderInstallationAdmissionError";
    this.blockers = blockers;
  }
}

export interface ProviderInstallationCleanupReceipt {
  cleanupConfirmed: true;
}

export interface ProviderInstallationUseLease {
  readonly identity: ProviderInstallationIdentity;
  readonly owner: ProviderInstallationUseOwner;
  release(receipt: ProviderInstallationCleanupReceipt): boolean;
  quarantine(reason: string): boolean;
}

const verificationAuthorityBrand: unique symbol = Symbol(
  "provider-installation-verification-authority",
);

/**
 * Process-local capability for post-command installation verification. It is
 * accepted only by the coordinator instance that issued it.
 */
export interface ProviderInstallationVerificationAuthority {
  readonly providerId: ProviderId;
  readonly operationId: string;
  readonly boundaryId: string;
  readonly scopeId: string;
  readonly [verificationAuthorityBrand]: symbol;
}

export interface ProviderInstallationUseAdmission {
  verificationAuthority?: ProviderInstallationVerificationAuthority;
}

export interface ProviderInstallationMaintenanceReceipt
  extends ProviderInstallationCleanupReceipt {
  stateDurable: true;
  observedIdentity: ProviderInstallationIdentity;
}

export interface ProviderInstallationMaintenanceLease {
  readonly identity: ProviderInstallationIdentity;
  readonly operationId: string;
  authorizePostMaintenanceVerification(
    receipt: ProviderInstallationCleanupReceipt,
  ): ProviderInstallationVerificationAuthority | null;
  complete(receipt: ProviderInstallationMaintenanceReceipt): boolean;
  quarantine(
    reason: string,
    observedIdentity?: ProviderInstallationIdentity,
  ): boolean;
}

export interface ProviderInstallationMaintenanceRequest {
  operationId: string;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
  onBlockers?(blockers: readonly ProviderInstallationBlocker[]): void;
}

interface UseRecord {
  token: symbol;
  identity: ProviderInstallationIdentity;
  owner: ProviderInstallationUseOwner;
}

interface MaintenanceRecord {
  token: symbol;
  identity: ProviderInstallationIdentity;
  operationId: string;
  phase: "pending" | "active" | "verifying" | "closed";
  scopes: Map<
    string,
    { state: InstallationState; identity: ProviderInstallationIdentity }
  >;
  verificationUses: Map<symbol, UseRecord>;
  verificationAuthority: ProviderInstallationVerificationAuthority | null;
}

interface QuarantineRecord {
  identity: ProviderInstallationIdentity;
  operationId: string;
  reason: string;
}

interface DrainWaiter {
  resolve(): void;
}

interface InstallationState {
  uses: Map<symbol, UseRecord>;
  maintenance: MaintenanceRecord | null;
  quarantine: QuarantineRecord | null;
  drainWaiters: Set<DrainWaiter>;
}

const MAX_WAIT_TIMEOUT_MS = 60_000;
const POST_MAINTENANCE_VERIFICATION_KINDS: ReadonlySet<
  ProviderInstallationUseKind
> = new Set([
  "metadata-discovery",
  "auth-discovery",
  "compatibility-probe",
  "isolation-proof",
  "drift-verification",
]);

function boundedIdentityPart(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replaceAll("\\", "/").trim();
  return normalized ? normalized.slice(0, 8_192) : null;
}

export function canonicalProviderExecutable(valueInput: string): string | null {
  const value = valueInput.trim();
  if (!value || value.includes("\0") || !isAbsolute(value)) return null;
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function sameProviderInstallationIdentity(
  left: ProviderInstallationIdentity,
  right: ProviderInstallationIdentity,
): boolean {
  return left.providerId === right.providerId
    && left.boundaryId === right.boundaryId
    && left.scopeId === right.scopeId
    && left.fingerprint === right.fingerprint;
}

export function sameProviderInstallationBoundary(
  left: ProviderInstallationIdentity,
  right: ProviderInstallationIdentity,
): boolean {
  return left.providerId === right.providerId
    && left.boundaryId === right.boundaryId;
}

export function sameProviderInstallationScope(
  left: ProviderInstallationIdentity,
  right: ProviderInstallationIdentity,
): boolean {
  return left.providerId === right.providerId
    && left.scopeId === right.scopeId;
}

function validOperationId(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 512 && !value.includes("\0");
}

export function providerInstallationIdentity(
  coordinates: ProviderInstallationCoordinates,
): ProviderInstallationIdentity {
  const executable = boundedIdentityPart(coordinates.executable);
  const installationRoot = boundedIdentityPart(
    coordinates.installationRootIdentity,
  );
  if (!executable && !installationRoot) {
    throw new Error("A provider installation path or root identity is required.");
  }
  const environmentIdentity = boundedIdentityPart(
    coordinates.environmentIdentity,
  );
  const physicalIdentity = executable ?? installationRoot;
  const replacementBoundary = boundedIdentityPart(
    coordinates.replacementBoundaryIdentity,
  ) ?? physicalIdentity;
  const scopeDigest = digest([
    coordinates.providerId,
    physicalIdentity,
  ]);
  return {
    providerId: coordinates.providerId,
    boundaryId: `${coordinates.providerId}:${digest([
      coordinates.providerId,
      replacementBoundary,
    ])}`,
    scopeId: `${coordinates.providerId}:${scopeDigest}`,
    fingerprint: digest([
      coordinates.providerId,
      physicalIdentity,
      boundedIdentityPart(coordinates.packageIdentity),
      boundedIdentityPart(coordinates.version),
      boundedIdentityPart(coordinates.directFileIdentity),
      boundedIdentityPart(coordinates.backendConfigurationIdentity),
      boundedIdentityPart(coordinates.profileIdentity),
      environmentIdentity,
    ]),
  };
}

/**
 * Process-local reader/writer authority for one exact provider installation.
 * A pending writer closes admission synchronously, then waits for existing
 * readers to produce explicit cleanup receipts. Uncertain cleanup is moved to
 * a retained process-local quarantine projection instead of reopening admission.
 */
export class ProviderInstallationLeaseCoordinator {
  private readonly states = new Map<string, InstallationState>();
  private readonly maintenanceByBoundary = new Map<string, MaintenanceRecord>();
  private readonly quarantineByBoundary = new Map<string, QuarantineRecord>();
  private readonly verificationAuthorities = new WeakMap<
    ProviderInstallationVerificationAuthority,
    MaintenanceRecord
  >();

  acquireUse(
    identity: ProviderInstallationIdentity,
    owner: ProviderInstallationUseOwner,
    admission: ProviderInstallationUseAdmission = {},
  ): ProviderInstallationUseLease {
    if (!validOperationId(owner.operationId)) {
      throw new Error("An exact provider installation operation ID is required.");
    }
    const verificationMaintenance = admission.verificationAuthority
      ? this.verificationAuthorities.get(admission.verificationAuthority)
      : undefined;
    if (admission.verificationAuthority) {
      if (!verificationMaintenance) {
        throw new ProviderInstallationAdmissionError(
          "The provider installation verification authority is invalid or expired.",
          [],
        );
      }
      return this.acquireVerificationUse(
        verificationMaintenance,
        admission.verificationAuthority,
        identity,
        owner,
      );
    }
    const state = this.state(identity.scopeId);
    const blockers = this.blockers(identity);
    if (
      state.maintenance
      || state.quarantine
      || this.maintenanceByBoundary.has(identity.boundaryId)
      || this.quarantineByBoundary.has(identity.boundaryId)
    ) {
      throw new ProviderInstallationAdmissionError(
        "The provider installation is unavailable while maintenance owns it.",
        blockers,
      );
    }
    const token = Symbol(owner.operationId);
    const record = { token, identity, owner };
    state.uses.set(token, record);
    let active = true;
    const quarantine = (reason: string): boolean => {
      if (!active || state.uses.get(token) !== record) return false;
      active = false;
      state.uses.delete(token);
      this.quarantineState(state, identity, owner.operationId, reason);
      this.notifyDrain(state);
      return true;
    };
    return {
      identity,
      owner,
      release: (receipt) => {
        if (!active || state.uses.get(token) !== record) return false;
        if (receipt?.cleanupConfirmed !== true) {
          quarantine("provider-use-cleanup-unconfirmed");
          return false;
        }
        active = false;
        state.uses.delete(token);
        this.notifyDrain(state);
        this.deleteIfEmpty(identity.scopeId, state);
        return true;
      },
      quarantine,
    };
  }

  async acquireMaintenance(
    identity: ProviderInstallationIdentity,
    request: ProviderInstallationMaintenanceRequest,
  ): Promise<ProviderInstallationMaintenanceLease> {
    if (!validOperationId(request.operationId)) {
      throw new Error("An exact provider maintenance operation ID is required.");
    }
    const state = this.state(identity.scopeId);
    if (
      state.maintenance
      || state.quarantine
      || this.maintenanceByBoundary.has(identity.boundaryId)
      || this.quarantineByBoundary.has(identity.boundaryId)
    ) {
      const blockers = this.blockers(identity);
      request.onBlockers?.(blockers);
      throw new ProviderInstallationAdmissionError(
        "The provider installation already has maintenance or quarantine authority.",
        blockers,
      );
    }
    const token = Symbol(request.operationId);
    const maintenance: MaintenanceRecord = {
      token,
      identity,
      operationId: request.operationId,
      phase: "pending",
      scopes: new Map([[identity.scopeId, { state, identity }]]),
      verificationUses: new Map(),
      verificationAuthority: null,
    };
    this.maintenanceByBoundary.set(identity.boundaryId, maintenance);
    const matchingStates = [...this.states.entries()].filter(([, candidate]) =>
      [...candidate.uses.values()].some(({ identity: useIdentity }) =>
        sameProviderInstallationBoundary(useIdentity, identity)));
    const conflicting = matchingStates.find(([, candidate]) =>
      candidate !== state && Boolean(candidate.maintenance || candidate.quarantine));
    if (conflicting) {
      this.maintenanceByBoundary.delete(identity.boundaryId);
      throw new ProviderInstallationAdmissionError(
        "The provider installation already has maintenance or quarantine authority.",
        this.blockersFromState(identity, conflicting[1]),
      );
    }
    for (const [scopeId, candidate] of matchingStates) {
      if (candidate === state) continue;
      candidate.maintenance = maintenance;
      const useIdentity = [...candidate.uses.values()].find(({ identity: candidateIdentity }) =>
        sameProviderInstallationBoundary(candidateIdentity, identity))!.identity;
      maintenance.scopes.set(scopeId, { state: candidate, identity: useIdentity });
    }
    state.maintenance = maintenance;
    const blockers = [...maintenance.scopes.values()].flatMap(({ state: owned }) =>
      this.blockersFromState(identity, owned)
        .filter(({ kind }) => kind !== "maintenance-pending"));
    if (blockers.length > 0) request.onBlockers?.(blockers);

    try {
      await Promise.all([...maintenance.scopes.values()].map(({ state: owned }) =>
        owned.uses.size > 0
          ? this.waitForDrain(
              identity,
              owned,
              request.signal,
              request.waitTimeoutMs,
            )
          : Promise.resolve()));
      if (request.signal?.aborted) {
        throw new ProviderInstallationAdmissionError(
          "Provider maintenance admission was cancelled.",
          [],
        );
      }
      if (
        state.maintenance !== maintenance
        || state.quarantine
        || [...maintenance.scopes.values()].some(({ state: owned }) =>
          owned.maintenance !== maintenance
          || owned.quarantine
          || owned.uses.size > 0)
      ) {
        throw new ProviderInstallationAdmissionError(
          "The provider installation could not establish exclusive maintenance authority.",
          this.blockersFromState(identity, state),
        );
      }
      maintenance.phase = "active";
    } catch (error) {
      this.clearMaintenance(maintenance);
      throw error;
    }

    let active = true;
    const quarantine = (
      reason: string,
      observedIdentity = identity,
    ): boolean => {
      if (!active || state.maintenance !== maintenance) return false;
      active = false;
      this.quarantineMaintenance(maintenance, reason, observedIdentity);
      return true;
    };
    return {
      identity,
      operationId: request.operationId,
      authorizePostMaintenanceVerification: (receipt) => {
        if (
          !active
          || state.maintenance !== maintenance
          || maintenance.phase !== "active"
        ) return null;
        if (receipt?.cleanupConfirmed !== true) {
          quarantine("maintenance-process-cleanup-unconfirmed");
          return null;
        }
        maintenance.phase = "verifying";
        const authority = Object.freeze({
          providerId: identity.providerId,
          operationId: request.operationId,
          boundaryId: identity.boundaryId,
          scopeId: identity.scopeId,
          [verificationAuthorityBrand]: token,
        });
        maintenance.verificationAuthority = authority;
        this.verificationAuthorities.set(authority, maintenance);
        return authority;
      },
      complete: (receipt) => {
        if (!active || state.maintenance !== maintenance) return false;
        const observedState = this.attachMaintenanceScope(
          maintenance,
          receipt?.observedIdentity,
        );
        if (
          maintenance.phase !== "verifying"
          || !maintenance.verificationAuthority
          || maintenance.verificationUses.size > 0
          || receipt?.cleanupConfirmed !== true
          || receipt.stateDurable !== true
          || !observedState
          || !sameProviderInstallationBoundary(
            maintenance.identity,
            receipt.observedIdentity,
          )
        ) {
          quarantine(
            "maintenance-terminal-receipt-mismatch",
            receipt?.observedIdentity ?? identity,
          );
          return false;
        }
        active = false;
        this.clearMaintenance(maintenance);
        return true;
      },
      quarantine,
    };
  }

  blockers(identity: ProviderInstallationIdentity): ProviderInstallationBlocker[] {
    const state = this.states.get(identity.scopeId);
    const direct = state ? this.blockersFromState(identity, state) : [];
    const maintenance = this.maintenanceByBoundary.get(identity.boundaryId);
    const quarantine = this.quarantineByBoundary.get(identity.boundaryId);
    return [
      ...direct,
      ...(maintenance && maintenance !== state?.maintenance
        ? [this.maintenanceBlocker(identity, maintenance)]
        : []),
      ...(quarantine && quarantine !== state?.quarantine
        ? [this.quarantineBlocker(identity, quarantine)]
        : []),
    ];
  }

  isQuarantined(identity: ProviderInstallationIdentity): boolean {
    return Boolean(
      this.states.get(identity.scopeId)?.quarantine
      || this.quarantineByBoundary.has(identity.boundaryId),
    );
  }

  /** Provider-scoped guard used immediately before logical route mutation. */
  hasProviderAuthority(providerId: ProviderId): boolean {
    return [...this.states.values()].some((state) => (
      [...state.uses.values()].some(({ identity }) =>
        identity.providerId === providerId)
      || state.maintenance?.identity.providerId === providerId
      || state.quarantine?.identity.providerId === providerId
    )) || [...this.maintenanceByBoundary.values()].some(
      ({ identity }) => identity.providerId === providerId,
    ) || [...this.quarantineByBoundary.values()].some(
      ({ identity }) => identity.providerId === providerId,
    );
  }

  /**
   * Retains a scope discovered only after an operation started. This is the
   * fail-closed path for an unexpected executable change; it never grants an
   * owner or releases an existing one.
   */
  quarantineObservation(
    identity: ProviderInstallationIdentity,
    owner: ProviderInstallationUseOwner,
    reason: string,
  ): void {
    if (!validOperationId(owner.operationId)) {
      throw new Error("An exact provider installation operation ID is required.");
    }
    const state = this.state(identity.scopeId);
    if (state.maintenance) {
      this.quarantineMaintenance(state.maintenance, reason, identity);
      return;
    }
    this.quarantineState(state, identity, owner.operationId, reason);
  }

  private acquireVerificationUse(
    maintenance: MaintenanceRecord,
    authority: ProviderInstallationVerificationAuthority,
    identity: ProviderInstallationIdentity,
    owner: ProviderInstallationUseOwner,
  ): ProviderInstallationUseLease {
    const primary = maintenance.scopes.get(maintenance.identity.scopeId)!;
    if (
      maintenance.phase !== "verifying"
      || maintenance.verificationAuthority !== authority
      || authority.providerId !== identity.providerId
      || authority.boundaryId !== identity.boundaryId
      || authority.operationId !== owner.operationId
      || !POST_MAINTENANCE_VERIFICATION_KINDS.has(owner.kind)
    ) {
      throw new ProviderInstallationAdmissionError(
        "The maintenance authority cannot admit this provider operation.",
        this.blockersFromState(maintenance.identity, primary.state),
      );
    }
    const scope = this.attachMaintenanceScope(maintenance, identity);
    if (!scope) {
      const target = this.state(identity.scopeId);
      const blockers = this.blockersFromState(identity, target);
      this.quarantineMaintenance(
        maintenance,
        "post-maintenance-verification-scope-conflict",
        identity,
      );
      throw new ProviderInstallationAdmissionError(
        "Post-maintenance verification found conflicting installation authority.",
        blockers,
      );
    }

    const token = Symbol(owner.operationId);
    const record = { token, identity, owner };
    maintenance.verificationUses.set(token, record);
    let active = true;
    const quarantine = (reason: string): boolean => {
      if (
        !active
        || maintenance.verificationUses.get(token) !== record
      ) return false;
      active = false;
      maintenance.verificationUses.delete(token);
      this.quarantineMaintenance(maintenance, reason, identity);
      return true;
    };
    return {
      identity,
      owner,
      release: (receipt) => {
        if (
          !active
          || maintenance.verificationUses.get(token) !== record
        ) return false;
        if (receipt?.cleanupConfirmed !== true) {
          quarantine("post-maintenance-verification-cleanup-unconfirmed");
          return false;
        }
        active = false;
        maintenance.verificationUses.delete(token);
        return true;
      },
      quarantine,
    };
  }

  private attachMaintenanceScope(
    maintenance: MaintenanceRecord,
    identity: ProviderInstallationIdentity | undefined,
  ): InstallationState | null {
    if (
      !identity
      || !sameProviderInstallationBoundary(identity, maintenance.identity)
    ) {
      return null;
    }
    const attached = maintenance.scopes.get(identity.scopeId);
    if (attached) {
      return attached.state.maintenance === maintenance
        && !attached.state.quarantine
        ? attached.state
        : null;
    }
    const state = this.state(identity.scopeId);
    if (
      state.uses.size > 0
      || state.quarantine
      || (state.maintenance && state.maintenance !== maintenance)
    ) return null;
    state.maintenance = maintenance;
    maintenance.scopes.set(identity.scopeId, { state, identity });
    return state;
  }

  private clearMaintenance(maintenance: MaintenanceRecord): void {
    maintenance.phase = "closed";
    if (
      this.maintenanceByBoundary.get(maintenance.identity.boundaryId)
      === maintenance
    ) {
      this.maintenanceByBoundary.delete(maintenance.identity.boundaryId);
    }
    if (maintenance.verificationAuthority) {
      this.verificationAuthorities.delete(maintenance.verificationAuthority);
    }
    for (const [scopeId, scope] of maintenance.scopes) {
      if (scope.state.maintenance === maintenance) {
        scope.state.maintenance = null;
      }
      this.deleteIfEmpty(scopeId, scope.state);
    }
    maintenance.verificationUses.clear();
  }

  private quarantineMaintenance(
    maintenance: MaintenanceRecord,
    reason: string,
    observedIdentity: ProviderInstallationIdentity,
  ): void {
    if (maintenance.phase === "closed") return;
    maintenance.phase = "closed";
    if (
      this.maintenanceByBoundary.get(maintenance.identity.boundaryId)
      === maintenance
    ) {
      this.maintenanceByBoundary.delete(maintenance.identity.boundaryId);
    }
    if (maintenance.verificationAuthority) {
      this.verificationAuthorities.delete(maintenance.verificationAuthority);
    }
    for (const scope of maintenance.scopes.values()) {
      if (scope.state.maintenance === maintenance) {
        scope.state.maintenance = null;
      }
      this.quarantineState(
        scope.state,
        scope.identity,
        maintenance.operationId,
        reason,
      );
    }
    if (!maintenance.scopes.has(observedIdentity.scopeId)) {
      this.quarantineState(
        this.state(observedIdentity.scopeId),
        observedIdentity,
        maintenance.operationId,
        reason,
      );
    }
    maintenance.verificationUses.clear();
  }

  private state(scopeId: string): InstallationState {
    const existing = this.states.get(scopeId);
    if (existing) return existing;
    const created: InstallationState = {
      uses: new Map(),
      maintenance: null,
      quarantine: null,
      drainWaiters: new Set(),
    };
    this.states.set(scopeId, created);
    return created;
  }

  private blockersFromState(
    expected: ProviderInstallationIdentity,
    state: InstallationState,
  ): ProviderInstallationBlocker[] {
    const uses = [...state.uses.values()].map(({ identity, owner }) => ({
      providerId: identity.providerId,
      scopeId: identity.scopeId,
      kind: owner.kind,
      operationId: owner.operationId,
      fingerprintMatches: sameProviderInstallationIdentity(identity, expected),
      reason: null,
    } satisfies ProviderInstallationBlocker));
    const maintenance = state.maintenance
      ? [{
          providerId: state.maintenance.identity.providerId,
          scopeId: state.maintenance.identity.scopeId,
          kind: state.maintenance.phase === "pending"
            ? "maintenance-pending" as const
            : "maintenance-active" as const,
          operationId: state.maintenance.operationId,
          fingerprintMatches: sameProviderInstallationIdentity(
            state.maintenance.identity,
            expected,
          ),
          reason: null,
        }]
      : [];
    const verificationUses = state.maintenance
      ? [...state.maintenance.verificationUses.values()]
          .filter(({ identity }) => identity.scopeId === expected.scopeId)
          .map(({ identity, owner }) => ({
            providerId: identity.providerId,
            scopeId: identity.scopeId,
            kind: owner.kind,
            operationId: owner.operationId,
            fingerprintMatches: sameProviderInstallationIdentity(
              identity,
              expected,
            ),
            reason: null,
          } satisfies ProviderInstallationBlocker))
      : [];
    const quarantine = state.quarantine
      ? [{
          providerId: state.quarantine.identity.providerId,
          scopeId: state.quarantine.identity.scopeId,
          kind: "quarantined" as const,
          operationId: state.quarantine.operationId,
          fingerprintMatches: sameProviderInstallationIdentity(
            state.quarantine.identity,
            expected,
          ),
          reason: state.quarantine.reason,
        }]
      : [];
    return [...uses, ...maintenance, ...verificationUses, ...quarantine];
  }

  private maintenanceBlocker(
    expected: ProviderInstallationIdentity,
    maintenance: MaintenanceRecord,
  ): ProviderInstallationBlocker {
    return {
      providerId: maintenance.identity.providerId,
      scopeId: maintenance.identity.scopeId,
      kind: maintenance.phase === "pending"
        ? "maintenance-pending"
        : "maintenance-active",
      operationId: maintenance.operationId,
      fingerprintMatches: sameProviderInstallationIdentity(
        maintenance.identity,
        expected,
      ),
      reason: null,
    };
  }

  private quarantineBlocker(
    expected: ProviderInstallationIdentity,
    quarantine: QuarantineRecord,
  ): ProviderInstallationBlocker {
    return {
      providerId: quarantine.identity.providerId,
      scopeId: quarantine.identity.scopeId,
      kind: "quarantined",
      operationId: quarantine.operationId,
      fingerprintMatches: sameProviderInstallationIdentity(
        quarantine.identity,
        expected,
      ),
      reason: quarantine.reason,
    };
  }

  private waitForDrain(
    identity: ProviderInstallationIdentity,
    state: InstallationState,
    signal: AbortSignal | undefined,
    timeoutInput: number | undefined,
  ): Promise<void> {
    const timeoutMs = Math.max(
      1,
      Math.min(timeoutInput ?? 10_000, MAX_WAIT_TIMEOUT_MS),
    );
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        state.drainWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const waiter: DrainWaiter = { resolve: () => finish() };
      const onAbort = (): void => finish(
        new ProviderInstallationAdmissionError(
          "Provider maintenance admission was cancelled.",
          [],
        ),
      );
      const timer = setTimeout(() => finish(
        new ProviderInstallationAdmissionError(
          "Provider maintenance timed out waiting for installation owners.",
          this.blockersFromState(identity, state).filter(
            ({ kind }) => kind !== "maintenance-pending",
          ),
        ),
      ), timeoutMs);
      timer.unref();
      state.drainWaiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (state.uses.size === 0) finish();
    });
  }

  private notifyDrain(state: InstallationState): void {
    if (state.uses.size > 0) return;
    for (const waiter of state.drainWaiters) waiter.resolve();
  }

  private quarantineState(
    state: InstallationState,
    identity: ProviderInstallationIdentity,
    operationId: string,
    reasonInput: string,
  ): void {
    const reason = reasonInput.replaceAll("\0", "").trim().slice(0, 240)
      || "provider-installation-cleanup-unconfirmed";
    state.quarantine ??= { identity, operationId, reason };
    this.quarantineByBoundary.set(
      identity.boundaryId,
      this.quarantineByBoundary.get(identity.boundaryId) ?? state.quarantine,
    );
  }

  private deleteIfEmpty(scopeId: string, state: InstallationState): void {
    if (
      state.uses.size === 0
      && !state.maintenance
      && !state.quarantine
      && state.drainWaiters.size === 0
      && this.states.get(scopeId) === state
    ) {
      this.states.delete(scopeId);
    }
  }
}
