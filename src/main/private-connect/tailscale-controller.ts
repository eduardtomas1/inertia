import {
  discoverTailscaleExecutable,
  extractTrustedServeConsentUrl,
  runTailscaleCommand,
  TailscaleCommandError,
  type TailscaleCommandResult,
} from "./tailscale-command";
import {
  choosePrivateConnectServePort,
  mappingMatchesPrivateConnect,
  privateConnectExternalUrl,
  privateConnectServeTarget,
  type PrivateConnectServeOwnership,
} from "./serve-ownership";
import {
  parseTailscaleServeStatus,
  parseTailscaleStatus,
  type TailscaleServeMapping,
  type TailscaleStatus,
} from "./tailscale-status";

export type PrivateConnectTailscaleErrorClass =
  | "not-installed"
  | "not-running"
  | "logged-out"
  | "permission-denied"
  | "serve-consent-required"
  | "magic-dns-unavailable"
  | "https-unavailable"
  | "serve-conflict"
  | "mapping-ownership-lost"
  | "command-timeout"
  | "invalid-status"
  | "endpoint-unreachable"
  | "unsupported-version"
  | "unknown";

export class PrivateConnectTailscaleError extends Error {
  constructor(
    readonly classification: PrivateConnectTailscaleErrorClass,
    message: string,
    readonly consentUrl: string | null = null,
  ) {
    super(message);
    this.name = "PrivateConnectTailscaleError";
  }
}

export interface PrivateConnectTailscaleReady {
  status: TailscaleStatus;
  servePort: number;
  gatewayPort: number;
  externalUrl: string;
  ownership: PrivateConnectServeOwnership;
}

export interface PrivateConnectTailscaleControllerOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  command?: typeof runTailscaleCommand;
  discover?: typeof discoverTailscaleExecutable;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class PrivateConnectTailscaleController {
  private readonly command: typeof runTailscaleCommand;
  private readonly discover: typeof discoverTailscaleExecutable;
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private executable: string | null = null;
  private owned: PrivateConnectServeOwnership | null = null;

  constructor(options: PrivateConnectTailscaleControllerOptions = {}) {
    this.command = options.command ?? runTailscaleCommand;
    this.discover = options.discover ?? discoverTailscaleExecutable;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async readStatus(): Promise<TailscaleStatus> {
    const executable = await this.requireExecutable();
    try {
      const result = await this.command(executable, ["status", "--json"]);
      return parseTailscaleStatus(parseJsonOutput(result.stdout));
    } catch (error) {
      throw classifyControllerError(error, "Tailscale status is unavailable.");
    }
  }

  async readServeStatus(): Promise<TailscaleServeMapping[]> {
    const executable = await this.requireExecutable();
    try {
      const result = await this.command(executable, ["serve", "status", "--json"]);
      return parseTailscaleServeStatus(parseJsonOutput(result.stdout)).mappings;
    } catch (error) {
      throw classifyControllerError(error, "Tailscale Serve status is unavailable.");
    }
  }

  async ensurePrivateServe(
    gatewayPort: number,
    preferredPort: number | null = this.owned?.port ?? null,
  ): Promise<PrivateConnectTailscaleReady> {
    const status = await this.readStatus();
    if (status.backendState !== "Running" || !status.connected) {
      throw status.backendState === "NeedsLogin"
        ? new PrivateConnectTailscaleError("logged-out", "Sign in to Tailscale on this computer.")
        : new PrivateConnectTailscaleError("not-running", "Tailscale is not connected on this computer.");
    }
    if (!status.dnsName) {
      throw new PrivateConnectTailscaleError("magic-dns-unavailable", "Tailscale MagicDNS is not available for this computer.");
    }
    const mappings = await this.readServeStatus();
    const existing = mappings.find((mapping) => mapping.port === preferredPort);
    if (existing?.funnel) {
      throw new PrivateConnectTailscaleError("serve-conflict", "The selected Tailscale Serve port is configured for Funnel.");
    }
    let servePort = existing && mappingMatchesPrivateConnect(existing, {
      port: existing.port,
      gatewayPort,
      target: privateConnectServeTarget(gatewayPort),
    })
      ? existing.port
      : choosePrivateConnectServePort(mappings, preferredPort);
    if (servePort === null) {
      throw new PrivateConnectTailscaleError("serve-conflict", "No safe Tailscale Serve port is available.");
    }
    const ownership: PrivateConnectServeOwnership = {
      port: servePort,
      gatewayPort,
      target: privateConnectServeTarget(gatewayPort),
    };
    if (!mappingMatchesPrivateConnect(
      mappings.find((mapping) => mapping.port === servePort) ?? { port: -1, host: null, target: null, funnel: false },
      ownership,
    )) {
      const result = await this.runServeCommand(servePort, gatewayPort);
      const consentUrl = extractTrustedServeConsentUrl(`${result.stdout}\n${result.stderr}`);
      if (consentUrl) {
        throw new PrivateConnectTailscaleError(
          "serve-consent-required",
          "Finish Tailscale HTTPS setup, then try again.",
          consentUrl,
        );
      }
    }
    const verified = await this.readServeStatus();
    const verifiedMapping = verified.find((mapping) => mapping.port === servePort);
    if (!verifiedMapping || !mappingMatchesPrivateConnect(verifiedMapping, ownership)) {
      throw new PrivateConnectTailscaleError("mapping-ownership-lost", "Tailscale Serve did not retain Inertia’s private mapping.");
    }
    this.owned = ownership;
    const externalUrl = privateConnectExternalUrl(status.dnsName, servePort);
    await this.probe(externalUrl, status.dnsName);
    return { status, servePort, gatewayPort, externalUrl, ownership };
  }

  async disableOwnedServe(gatewayPort: number): Promise<void> {
    const ownership = this.owned;
    if (!ownership || ownership.gatewayPort !== gatewayPort) return;
    const mappings = await this.readServeStatus();
    const current = mappings.find((mapping) => mapping.port === ownership.port);
    if (!current || !mappingMatchesPrivateConnect(current, ownership)) {
      this.owned = null;
      throw new PrivateConnectTailscaleError("mapping-ownership-lost", "The Tailscale Serve mapping changed, so Inertia left it untouched.");
    }
    const executable = await this.requireExecutable();
    try {
      await this.command(executable, ["serve", `--https=${ownership.port}`, "off"]);
      this.owned = null;
    } catch (error) {
      throw classifyControllerError(error, "Inertia could not disable its Tailscale Serve mapping.");
    }
  }

  currentOwnership(): PrivateConnectServeOwnership | null {
    return this.owned;
  }

  private async requireExecutable(): Promise<string> {
    if (this.executable) return this.executable;
    this.executable = await this.discover(this.platform, this.environment);
    if (!this.executable) throw new PrivateConnectTailscaleError("not-installed", "Install Tailscale to use Private Connect.");
    return this.executable;
  }

  private async runServeCommand(servePort: number, gatewayPort: number): Promise<TailscaleCommandResult> {
    const executable = await this.requireExecutable();
    try {
      return await this.command(executable, [
        "serve",
        "--bg",
        "--yes",
        `--https=${servePort}`,
        `http://127.0.0.1:${gatewayPort}`,
      ]);
    } catch (error) {
      throw classifyControllerError(error, "Tailscale could not configure private HTTPS.");
    }
  }

  private async probe(externalUrl: string, expectedHost: string): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 7_000);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(
        new URL(".well-known/inertia/private-connect", externalUrl),
        { cache: "no-store", redirect: "error", signal: abort.signal },
      );
      if (!response.ok) throw new Error("The endpoint returned an unexpected status.");
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== "object" || (payload as { product?: unknown }).product !== "Inertia Private Connect") {
        throw new Error("The endpoint identity did not match.");
      }
      if (new URL(externalUrl).hostname !== expectedHost) throw new Error("The endpoint host did not match.");
    } catch (error) {
      if (error instanceof PrivateConnectTailscaleError) throw error;
      throw new PrivateConnectTailscaleError("endpoint-unreachable", "The private HTTPS endpoint could not be verified.");
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJsonOutput(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") > 128 * 1024) throw new Error("Tailscale JSON output was too large.");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PrivateConnectTailscaleError("invalid-status", "Tailscale returned invalid status data.");
  }
}

function classifyControllerError(error: unknown, fallback: string): PrivateConnectTailscaleError {
  if (error instanceof PrivateConnectTailscaleError) return error;
  if (error instanceof TailscaleCommandError) {
    const classification: PrivateConnectTailscaleErrorClass = error.classification === "not-installed"
      ? "not-installed"
      : error.classification === "not-running"
        ? "not-running"
        : error.classification === "logged-out"
          ? "logged-out"
          : error.classification === "permission-denied"
            ? "permission-denied"
            : error.classification === "serve-consent-required"
              ? "serve-consent-required"
              : error.classification === "command-timeout"
                ? "command-timeout"
                : "unknown";
    return new PrivateConnectTailscaleError(classification, fallback);
  }
  return new PrivateConnectTailscaleError("unknown", fallback);
}
