import type { PrivateConnectGatewayServer } from "./gateway-server";
import type { PersistedPrivateConnect } from "./store";
import {
  PrivateConnectTailscaleError,
  type PrivateConnectServeProof,
  type PrivateConnectTailscaleController,
} from "./tailscale-controller";

const SERVE_REMOVAL_RETRY_MS = 5_000;
const SERVE_REMOVAL_RETRY_MAX_MS = 60_000;
const SERVE_REMOVAL_HELD_NOTICE = "Private Connect is off, but Inertia could not remove its Tailscale Serve mapping yet. Inertia is keeping the local gateway port closed and will keep retrying; review Tailscale Serve if this notice stays.";
const SERVE_REMOVAL_STALE_NOTICE = "Inertia could not yet remove a Tailscale Serve mapping left by an earlier session. Private Connect stays off while Inertia retries; check that Tailscale is running.";
const SERVE_REMOVAL_STALE_RESUME_NOTICE = "Inertia could not yet remove a Tailscale Serve mapping left by an earlier session. Private Connect will turn back on once it is removed; check that Tailscale is running.";
const SERVE_REMOVAL_CHANGED_NOTICE = "Private Connect is off, but the Tailscale Serve mapping changed outside Inertia and was left untouched. Review it in Tailscale before re-enabling.";
const SERVE_STALE_SIGNED_OUT_NOTICE = "Another app was using Private Connect's earlier local port, so paired browsers were signed out as a precaution. Pair them again in Settings → Devices & integrations.";
const SERVE_REMOVAL_REFUSED_MESSAGE = "Inertia could not remove its earlier Tailscale Serve mapping, so Private Connect stays off. Check that Tailscale is running, then try again.";
const SERVE_REMOVAL_RESUME_MESSAGE = "Inertia could not remove its earlier Tailscale Serve mapping yet. Private Connect will turn on once it is removed; check that Tailscale is running.";
const RETRY_NOTICES = new Set([SERVE_REMOVAL_HELD_NOTICE, SERVE_REMOVAL_STALE_NOTICE, SERVE_REMOVAL_STALE_RESUME_NOTICE]);
const PORT_HELD_CODES = new Set(["EADDRINUSE", "EACCES"]);

interface PendingServeRemoval {
  gatewayPort: number | null;
  clearPort: boolean;
  previousRun: boolean;
  attempts: number;
  classification: PrivateConnectTailscaleError["classification"];
  timer: ReturnType<typeof setTimeout> | null;
}

export type PrivateConnectServeMappingOwnership = "owned" | "missing" | "unrelated";

export interface PrivateConnectServeRemovalHost {
  readonly tailscale: Pick<PrivateConnectTailscaleController, "disableOwnedServe">;
  readonly retryMs?: number;
  data(): PersistedPrivateConnect | null;
  gateway(): PrivateConnectGatewayServer;
  replaceGateway(): PrivateConnectGatewayServer;
  readonly sessions: Map<string, unknown>;
  readonly tickets: Map<string, unknown>;
  warn(detail: string): void;
  notice(): string | null;
  setNotice(notice: string | null): void;
  setMappingOwnership(ownership: PrivateConnectServeMappingOwnership): void;
  stopped(): boolean;
  resume(): void;
  enqueue(operation: () => Promise<void>): void;
  persist(): Promise<void>;
  emit(): void;
}

export function persistedServeProof(data: PersistedPrivateConnect | null): PrivateConnectServeProof | null {
  return data?.servePort && data.serveTarget
    ? { port: data.servePort, target: data.serveTarget }
    : null;
}

export class PrivateConnectServeRemoval {
  private pending: PendingServeRemoval | null = null;
  private resumeOnRemoval = false;
  private signedOut = false;

  constructor(private readonly host: PrivateConnectServeRemovalHost) {}

  cancel(): boolean {
    const pending = this.pending;
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending = null;
    return pending !== null;
  }

  async release(gatewayPort: number | null, clearPort: boolean, previousRun: boolean): Promise<boolean> {
    const host = this.host;
    const pending = this.pending;
    this.cancel();
    const port = gatewayPort ?? pending?.gatewayPort ?? null;
    const clear = clearPort || pending?.clearPort === true;
    const fromPreviousRun = previousRun || pending?.previousRun === true;
    const gateway = host.gateway();
    gateway.quarantine();
    let outcome: "removed" | "absent" | "changed";
    try {
      outcome = await host.tailscale.disableOwnedServe(port, persistedServeProof(host.data())) === "absent" ? "absent" : "removed";
    } catch (error) {
      if (!(error instanceof PrivateConnectTailscaleError && error.classification === "mapping-ownership-lost")) {
        this.pending = {
          gatewayPort: port,
          clearPort: clear,
          previousRun: fromPreviousRun,
          attempts: (pending?.attempts ?? 0) + 1,
          classification: error instanceof PrivateConnectTailscaleError ? error.classification : "unknown",
          timer: null,
        };
        host.setNotice(!fromPreviousRun ? SERVE_REMOVAL_HELD_NOTICE
          : this.resuming() ? SERVE_REMOVAL_STALE_RESUME_NOTICE : SERVE_REMOVAL_STALE_NOTICE);
        host.setMappingOwnership("owned");
        this.schedule();
        return false;
      }
      outcome = "changed";
    }
    const data = host.data();
    if (data) {
      data.serveTarget = null;
      if (clear) data.servePort = null;
    }
    const notice = host.notice();
    if (notice !== null && RETRY_NOTICES.has(notice)) host.setNotice(this.signedOut ? SERVE_STALE_SIGNED_OUT_NOTICE : null);
    this.resumeOnRemoval = false;
    this.signedOut = false;
    if (outcome === "changed") {
      host.setNotice(SERVE_REMOVAL_CHANGED_NOTICE);
      host.setMappingOwnership("unrelated");
      host.warn("Inertia left an unrecognized Tailscale Serve mapping untouched.");
    } else {
      host.setMappingOwnership("missing");
    }
    if (outcome === "removed" && fromPreviousRun) host.warn("Inertia removed a Tailscale Serve mapping left by an earlier session.");
    await gateway.stop().catch(() => undefined);
    return true;
  }

  async beforeEnable(): Promise<void> {
    if (!this.pending && !persistedServeProof(this.host.data())) return;
    const resume = this.resuming();
    if (await this.release(null, false, false)) return;
    throw new PrivateConnectTailscaleError(
      this.pending?.classification ?? "unknown",
      resume ? SERVE_REMOVAL_RESUME_MESSAGE : SERVE_REMOVAL_REFUSED_MESSAGE,
    );
  }

  async fromPreviousRun(): Promise<void> {
    const host = this.host;
    const proof = persistedServeProof(host.data());
    if (!proof) return;
    const holder = host.replaceGateway();
    holder.quarantine();
    const previousGatewayPort = Number(proof.target.slice(proof.target.lastIndexOf(":") + 1));
    const bindFailure = Number.isInteger(previousGatewayPort) && previousGatewayPort > 0 && previousGatewayPort <= 65_535
      ? await holder.start(previousGatewayPort).then(() => null, (error: unknown) => error)
      : null;
    if (PORT_HELD_CODES.has((bindFailure as NodeJS.ErrnoException | null)?.code ?? "")) this.endSessionsAfterExposure();
    else host.warn("Inertia found a Tailscale Serve mapping left by an earlier session. Its local gateway port was free, so browser sessions were kept.");
    this.resumeOnRemoval = host.data()?.enabled === true;
    await this.release(null, false, true);
    await host.persist();
  }

  private resuming(): boolean {
    return this.resumeOnRemoval && this.host.data()?.enabled === true;
  }

  private endSessionsAfterExposure(): void {
    const host = this.host;
    const data = host.data();
    const hadSessions = host.sessions.size > 0 || (data?.sessions.length ?? 0) > 0;
    host.sessions.clear();
    host.tickets.clear();
    if (data) data.sessions = [];
    host.warn("Another process held the local gateway port of a Tailscale Serve mapping left by an earlier session, so Inertia ended browser sessions as a precaution.");
    if (!hadSessions) return;
    this.signedOut = true;
    host.setNotice(SERVE_STALE_SIGNED_OUT_NOTICE);
  }

  private schedule(): void {
    const pending = this.pending;
    if (!pending || this.host.stopped()) return;
    const base = Math.max(1, this.host.retryMs ?? SERVE_REMOVAL_RETRY_MS);
    const delay = Math.min(base * 2 ** Math.min(pending.attempts - 1, 8), Math.max(base, SERVE_REMOVAL_RETRY_MAX_MS));
    pending.timer = setTimeout(() => {
      this.host.enqueue(async () => {
        if (this.host.stopped() || this.pending !== pending) return;
        const resume = this.resuming();
        if (await this.release(null, false, false)) {
          await this.host.persist().catch(() => undefined);
          if (resume) this.host.resume();
        }
        this.host.emit();
      });
    }, delay);
    pending.timer.unref?.();
  }
}
