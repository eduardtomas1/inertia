import { objectValue, type JsonObject } from "../codex/protocol";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 128 * 1024 * 1024;

export class OpenCode2RequestError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "OpenCode 2 request failed." : `OpenCode 2 request failed (HTTP ${status}).`);
  }
}

export interface OpenCode2EventStream {
  /** Resolves only after an intentional close; interrupted streams reject. */
  done: Promise<void>;
  close(): Promise<void>;
}

export interface OpenCode2ClientOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  eventSilenceMs?: number;
  fetch?: typeof fetch;
}

/** Official OpenCode 2 HTTP contract. No redirects, retries, or external endpoints. */
export class OpenCode2Client {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;
  constructor(private readonly baseUrl: string, password: string, private readonly options: OpenCode2ClientOptions = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || password.length < 16 || password.length > 512 || /[\0\r\n]/u.test(password)) {
      throw new Error("Invalid owned OpenCode 2 connection.");
    }
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
    this.fetch = options.fetch ?? fetch;
  }

  async request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined && Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("OpenCode 2 input exceeded its safety limit.");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(this.options.signal ? [this.options.signal] : [])]);
    const timeoutMs = boundedTimeout(this.options.timeoutMs, 30_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    try {
      const response = await this.fetch(this.url(path), {
        method, body: payload, redirect: "error", signal,
        headers: { Authorization: this.authorization, Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      });
      if (!response.ok) { await response.body?.cancel(); throw new OpenCode2RequestError(response.status); }
      if (response.status === 204) { await response.body?.cancel(); return undefined; }
      if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new Error("OpenCode 2 returned a non-JSON response.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("OpenCode 2 returned an empty response.");
      let total = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_RESPONSE_BYTES) throw new Error("OpenCode 2 response exceeded its safety limit.");
          chunks.push(next.value);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      if (error instanceof OpenCode2RequestError) throw error;
      // Fetch errors may embed URLs, headers or arbitrary provider content.
      throw new OpenCode2RequestError(null);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  /** Resolves on HTTP subscription acceptance, before the caller submits any work. */
  async events(onEvent: (event: JsonObject) => void): Promise<OpenCode2EventStream> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(this.options.signal ? [this.options.signal] : [])]);
    let timer = setTimeout(() => controller.abort(), boundedTimeout(this.options.timeoutMs, 30_000)); timer.unref();
    let intentional = false;
    let response: Response;
    try {
      response = await this.fetch(this.url("/api/event"), {
        redirect: "error", signal, headers: { Authorization: this.authorization, Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body || !/^text\/event-stream(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new Error("Invalid OpenCode 2 event response.");
      }
    } catch { clearTimeout(timer); controller.abort(); throw new OpenCode2RequestError(null); }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let line = ""; let data: string[] = []; let frameBytes = 0; let total = 0; let count = 0; let afterCr = false;
    const lineEnded = (): void => {
      if (!line) {
        if (data.length) {
          const event = objectValue(JSON.parse(data.join("\n")));
          if (!event || typeof event.type !== "string" || event.type.length > 128 || ++count > 16_384) {
            throw new Error("Invalid OpenCode 2 event.");
          }
          onEvent(event);
        }
        data = []; frameBytes = 0;
      } else if (line === "data") data.push("");
      else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
      line = "";
    };
    const done = (async () => {
      try {
        while (true) {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), boundedTimeout(this.options.eventSilenceMs, 45_000)); timer.unref();
          const next = await reader.read();
          if (next.done) { decoder.decode(); if (!intentional) throw new Error("OpenCode 2 event stream ended."); break; }
          total += next.value.byteLength;
          if (total > MAX_STREAM_BYTES) throw new Error("OpenCode 2 event stream exceeded its safety limit.");
          const text = decoder.decode(next.value, { stream: true });
          for (const character of text) {
            if (character === "\n" && afterCr) { afterCr = false; continue; }
            afterCr = character === "\r";
            frameBytes += Buffer.byteLength(character, "utf8");
            if (frameBytes > MAX_EVENT_BYTES) throw new Error("OpenCode 2 event exceeded its safety limit.");
            if (character === "\n" || character === "\r") lineEnded();
            else line += character;
          }
        }
      } catch { if (!intentional) throw new Error("OpenCode 2 event stream failed."); }
      finally { clearTimeout(timer); controller.abort(); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    })();
    // The caller races this promise with run completion; install a handler immediately.
    void done.catch(() => undefined);
    return { done, close: async () => { intentional = true; controller.abort(); await done; } };
  }

  private url(path: string): string {
    if (!path.startsWith("/api/") || /[\0\r\n#\\]/u.test(path)) throw new Error("Invalid OpenCode 2 API path.");
    const target = new URL(path, this.baseUrl);
    if (target.origin !== new URL(this.baseUrl).origin || !target.pathname.startsWith("/api/")) throw new Error("Invalid OpenCode 2 API path.");
    return target.href;
  }
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? maximum : Math.max(1, Math.min(value, maximum));
}
