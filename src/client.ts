import { BrowserError, type BrowserArguments, type BrowserConnection, type BrowserExecutor, type BrowserOperation } from "./protocol.js";
import { validConnection } from "./connection.js";

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export class BrowserClient implements BrowserExecutor {
  private readonly connection: BrowserConnection;
  private readonly requestTimeoutMs: number;

  constructor(connection: BrowserConnection, options: { requestTimeoutMs?: number } = {}) {
    if (!validConnection(connection)) throw new BrowserError("INVALID_CONNECTION", "Invalid browser bridge connection.");
    this.connection = { ...connection };
    this.requestTimeoutMs = options.requestTimeoutMs ?? 65_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 300_000) {
      throw new BrowserError("INVALID_TIMEOUT", "The request timeout must be between 1 and 300000 milliseconds.");
    }
  }

  async execute(sessionId: string, operation: BrowserOperation, args: BrowserArguments = {}): Promise<unknown> {
    // The bridge may use a shorter deadline, but a queued action must not outlive
    // this client's own request budget.
    return this.request("/command", { sessionId, operation, args, deadlineMs: Date.now() + this.requestTimeoutMs });
  }

  async status(): Promise<unknown> {
    return this.request("/status");
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.connection.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.connection.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        redirect: "error",
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new BrowserError("RESPONSE_TOO_LARGE", "Browser response exceeds the size limit.");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new BrowserError("INVALID_RESPONSE", "The browser bridge returned an invalid response."); }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new BrowserError("INVALID_RESPONSE", "The browser bridge returned an invalid response.");
      }
      const envelope = payload as { error?: { code?: unknown; message?: unknown }; result?: unknown };
      if ("error" in envelope && "result" in envelope) {
        throw new BrowserError("INVALID_RESPONSE", "The browser bridge returned an invalid response.");
      }
      if (envelope.error && typeof envelope.error.code === "string" && typeof envelope.error.message === "string") {
        throw new BrowserError(envelope.error.code, envelope.error.message);
      }
      if (!response.ok) throw new BrowserError("BRIDGE_ERROR", `The browser bridge rejected the request (${response.status}).`);
      if (!("result" in envelope)) throw new BrowserError("INVALID_RESPONSE", "The browser bridge returned an invalid response.");
      return envelope.result;
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new BrowserError("TIMEOUT", "The browser bridge request timed out. Its action may have completed; inspect the page before retrying.");
      }
      throw new BrowserError("BRIDGE_UNAVAILABLE", "Cannot reach the local browser bridge. Start it and reconnect the extension.");
    }
  }
}
