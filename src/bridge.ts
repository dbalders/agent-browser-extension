import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { BrowserError, DEFAULT_PORT, OPERATIONS, PROTOCOL_VERSION, type BrowserCommand, type BrowserHello } from "./protocol.js";
import { BROWSER_INSTRUCTIONS, browserTools } from "./tools.js";

export const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 128;
const extensionOrigin = /^(chrome|edge)-extension:\/\/[a-p]{32}$/;
const operations = new Set<string>(OPERATIONS);

export interface BridgeOptions {
  port?: number;
  host?: string;
  token?: string;
  requestTimeoutMs?: number;
}

export interface RunningBridge {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface ExtensionConnection {
  socket: WebSocket;
  hello?: BrowserHello;
  helloTimer: ReturnType<typeof setTimeout>;
}

interface PendingCommand {
  connection: ExtensionConnection;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: BrowserError): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function parseCommand(value: unknown): BrowserCommand {
  if (!isRecord(value) || !validIdentity(value.sessionId) || typeof value.operation !== "string" || !operations.has(value.operation) ||
    (value.type !== undefined && value.type !== "command") || (value.id !== undefined && !validIdentity(value.id)) ||
    (value.args !== undefined && !isRecord(value.args)) ||
    (value.deadlineMs !== undefined && (!Number.isSafeInteger(value.deadlineMs) || Number(value.deadlineMs) < 1)) ||
    Object.keys(value).some((key) => !["type", "id", "sessionId", "operation", "args", "deadlineMs"].includes(key))) {
    throw new BrowserError("INVALID_COMMAND", "Expected a session ID, supported browser operation and object arguments.");
  }
  return { type: "command", id: randomUUID(), sessionId: value.sessionId, operation: value.operation as BrowserCommand["operation"], args: value.args ?? {}, ...(value.deadlineMs === undefined ? {} : { deadlineMs: value.deadlineMs }) } as BrowserCommand;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_MESSAGE_BYTES) throw new BrowserError("REQUEST_TOO_LARGE", "Browser command exceeds the size limit.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_MESSAGE_BYTES) throw new BrowserError("REQUEST_TOO_LARGE", "Browser command exceeds the size limit.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BrowserError("INVALID_COMMAND", "The browser command must be valid JSON."); }
}

export async function startBridge(options: BridgeOptions = {}): Promise<RunningBridge> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") throw new BrowserError("LOOPBACK_REQUIRED", "The browser bridge must bind to 127.0.0.1 or localhost.");
  const requestedPort = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new BrowserError("INVALID_PORT", "Invalid browser bridge port.");
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new BrowserError("INVALID_TIMEOUT", "The command timeout must be between 1 and 300000 milliseconds.");
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new BrowserError("INVALID_TOKEN", "The bridge token must contain 32 to 256 printable non-space characters.");
  const secret = Buffer.from(token);
  const authorized = (candidate: unknown): boolean => {
    if (typeof candidate !== "string" || candidate.length > 256) return false;
    const supplied = Buffer.from(candidate);
    return supplied.length === secret.length && timingSafeEqual(supplied, secret);
  };
  const pending = new Map<string, PendingCommand>();
  let extension: ExtensionConnection | undefined;
  let closing = false;
  let port = requestedPort;
  const validHost = (request: IncomingMessage): boolean => request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;

  function dropConnection(connection: ExtensionConnection, code: string, message: string): void {
    clearTimeout(connection.helloTimer);
    if (extension === connection) extension = undefined;
    for (const [id, command] of pending) {
      if (command.connection !== connection) continue;
      clearTimeout(command.timer);
      pending.delete(id);
      command.reject(new BrowserError(code, message));
    }
  }

  function execute(command: BrowserCommand): Promise<unknown> {
    const now = Date.now();
    // Callers may shorten the bridge budget but cannot extend it. Retaining a
    // client deadline prevents queued actions from starting after its timeout.
    command.deadlineMs = Math.min(command.deadlineMs ?? Infinity, now + timeoutMs);
    const remainingMs = command.deadlineMs - now;
    if (remainingMs <= 0) return Promise.reject(new BrowserError("COMMAND_EXPIRED", "This browser command expired before dispatch."));
    const connection = extension;
    if (!connection?.hello || connection.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserError("EXTENSION_DISCONNECTED", "Connect the agent-browser-extension extension before running a browser command."));
    }
    if (pending.size >= MAX_PENDING_COMMANDS) return Promise.reject(new BrowserError("BRIDGE_BUSY", "Too many browser commands are pending."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(command.id);
        reject(new BrowserError("TIMEOUT", "The browser command timed out. Its action may have completed; inspect the page before retrying."));
      }, remainingMs);
      pending.set(command.id, { connection, timer, resolve, reject });
      connection.socket.send(JSON.stringify(command), (error) => {
        if (!error) return;
        dropConnection(connection, "EXTENSION_DISCONNECTED", "The browser extension disconnected. Actions are not replayed automatically.");
        connection.socket.terminate();
      });
    });
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (!validHost(request)) return sendError(response, 403, "INVALID_HOST", "Only the local bridge host is accepted.");
      const origin = request.headers.origin;
      if (origin !== undefined && !extensionOrigin.test(origin)) return sendError(response, 403, "INVALID_ORIGIN", "Website requests are not accepted by the browser bridge.");
      const auth = request.headers.authorization;
      if (!auth?.startsWith("Bearer ") || !authorized(auth.slice(7))) return sendError(response, 401, "UNAUTHORIZED", "A valid bridge token is required.");
      if (closing) return sendError(response, 503, "BRIDGE_CLOSED", "The browser bridge is closing.");
      if (request.method === "GET" && request.url === "/status") {
        return sendJson(response, 200, { result: { connected: Boolean(extension?.hello), version: PROTOCOL_VERSION, ...(extension?.hello ? { browser: extension.hello.browser, ...(extension.hello.profile === undefined ? {} : { profile: extension.hello.profile }) } : {}) } });
      }
      if (request.method === "GET" && request.url === "/tools") {
        return sendJson(response, 200, { tools: browserTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema, { io: "input" }), operation: tool.operation, readOnly: tool.readOnly === true })), instructions: BROWSER_INSTRUCTIONS });
      }
      if (request.method !== "POST" || request.url !== "/command") return sendError(response, 404, "NOT_FOUND", "Unknown browser bridge endpoint.");
      if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return sendError(response, 415, "INVALID_CONTENT_TYPE", "Browser commands require application/json.");
      const command = parseCommand(await readJson(request));
      const result = await execute(command);
      sendJson(response, 200, { result: result === undefined ? null : result });
    })().catch((error: unknown) => {
      const code = error instanceof BrowserError ? error.code : "BRIDGE_ERROR";
      const status = code === "REQUEST_TOO_LARGE" ? 413 : code === "INVALID_COMMAND" ? 400 : code === "TIMEOUT" || code === "COMMAND_EXPIRED" ? 504 : code === "BRIDGE_BUSY" ? 429 : code === "EXTENSION_DISCONNECTED" || code === "BRIDGE_CLOSED" ? 503 : 502;
      sendError(response, status, code, error instanceof BrowserError ? error.message : "The browser bridge could not complete the request.");
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => undefined);
    if (closing || !validHost(request)) return rejectUpgrade(socket, 403, "Forbidden");
    if (!request.headers.origin || !extensionOrigin.test(request.headers.origin)) return rejectUpgrade(socket, 403, "Forbidden");
    let url: URL;
    try { url = new URL(request.url ?? "", `http://127.0.0.1:${port}`); }
    catch { return rejectUpgrade(socket, 400, "Bad Request"); }
    if (url.pathname !== "/extension" || url.origin !== `http://127.0.0.1:${port}` || !request.url?.startsWith("/")) return rejectUpgrade(socket, 404, "Not Found");
    if (url.searchParams.getAll("token").length !== 1 || !authorized(url.searchParams.get("token"))) return rejectUpgrade(socket, 401, "Unauthorized");
    if (extension) return rejectUpgrade(socket, 409, "Conflict");
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      const connection: ExtensionConnection = {
        socket: websocket,
        helloTimer: setTimeout(() => {
          dropConnection(connection, "EXTENSION_DISCONNECTED", "The extension handshake timed out.");
          websocket.close(1008, "Handshake required");
        }, 5000),
      };
      extension = connection;
      websocket.on("error", () => {
        dropConnection(connection, "EXTENSION_DISCONNECTED", "The browser extension disconnected. Actions are not replayed automatically.");
        websocket.terminate();
      });
      websocket.on("close", () => dropConnection(connection, "EXTENSION_DISCONNECTED", "The browser extension disconnected. Actions are not replayed automatically."));
      const invalidMessage = (): void => {
        dropConnection(connection, "INVALID_EXTENSION_MESSAGE", "The browser extension sent an invalid protocol message.");
        websocket.close(1002, "Invalid protocol message");
      };
      websocket.on("message", (data, isBinary) => {
        if (isBinary) return invalidMessage();
        let value: unknown;
        try { value = JSON.parse(data.toString()); } catch { return invalidMessage(); }
        if (!isRecord(value)) return invalidMessage();
        if (!connection.hello) {
          if (value.type !== "hello" || value.version !== PROTOCOL_VERSION || typeof value.browser !== "string" || value.browser.length < 1 || value.browser.length > 64 ||
            (value.profile !== undefined && (typeof value.profile !== "string" || value.profile.length > 128))) return invalidMessage();
          if (extension !== connection) return invalidMessage();
          connection.hello = { type: "hello", version: PROTOCOL_VERSION, browser: value.browser, ...(typeof value.profile === "string" ? { profile: value.profile } : {}) };
          clearTimeout(connection.helloTimer);
          return;
        }
        if (value.type === "ping") {
          websocket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (value.type === "pong") return;
        if (value.type !== "result" || !validIdentity(value.id) || (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== "string" || value.error.code.length > 128 || typeof value.error.message !== "string" || value.error.message.length > 8192)) || (("result" in value) === ("error" in value))) return invalidMessage();
        const command = pending.get(value.id);
        // Expired responses and responses from an obsolete connection cannot satisfy another request.
        if (!command || command.connection !== connection || extension !== connection) return;
        pending.delete(value.id);
        clearTimeout(command.timer);
        if (isRecord(value.error)) command.reject(new BrowserError(value.error.code as string, value.error.message as string));
        else command.resolve(value.result ?? null);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) port = address.port;
      resolve();
    });
  });
  let closePromise: Promise<void> | undefined;
  return {
    port,
    token,
    close() {
      closePromise ??= (async () => {
        closing = true;
        if (extension) dropConnection(extension, "BRIDGE_CLOSED", "The browser bridge is closing.");
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}
