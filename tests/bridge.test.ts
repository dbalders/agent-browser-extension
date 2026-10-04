import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { request } from "node:http";
import { startBridge, MAX_MESSAGE_BYTES, type RunningBridge } from "../src/bridge.js";
import { BrowserClient } from "../src/client.js";
import type { BrowserCommand } from "../src/protocol.js";

const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const bridges: RunningBridge[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function bridge(options: Parameters<typeof startBridge>[0] = {}) {
  const value = await startBridge({ port: 0, ...options });
  bridges.push(value);
  return value;
}

async function connect(value: RunningBridge, options: { origin?: string; token?: string; hello?: boolean } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${value.port}/extension?token=${encodeURIComponent(options.token ?? value.token)}`, { origin: options.origin ?? ORIGIN });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  if (options.hello !== false) {
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify({ type: "hello", version: 1, browser: "Chrome" }), (error) => error ? reject(error) : resolve());
    });
    // The ping round trip ensures the preceding hello was processed before HTTP commands begin.
    await new Promise<void>((resolve) => { socket.once("pong", () => resolve()); socket.ping(); });
  }
  return socket;
}

function nextCommand(socket: WebSocket): Promise<BrowserCommand> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

function rawRequest(value: RunningBridge, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: value.port, method: options.method ?? "GET", path: options.path ?? "/status", headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("local browser bridge", () => {
  it("requires a private bearer token and rejects website origins and rebound hosts", async () => {
    const value = await bridge();
    expect((await rawRequest(value)).status).toBe(401);
    expect((await rawRequest(value, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const authorized = { authorization: `Bearer ${value.token}` };
    const status = await rawRequest(value, { headers: authorized });
    expect(status.body).toEqual({ result: { connected: false, version: 1 } });
    expect(JSON.stringify(status.body)).not.toContain(value.token);
    const website = await rawRequest(value, { headers: { ...authorized, origin: "https://attacker.example" } });
    expect(website.status).toBe(403);
    expect(website.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await rawRequest(value, { headers: { ...authorized, host: `attacker.example:${value.port}` } })).status).toBe(403);
    expect((await rawRequest(value, { method: "OPTIONS", headers: { origin: "https://attacker.example" } })).status).toBe(403);
  });

  it("exposes the shared tool catalog only to authenticated local requests", async () => {
    const value = await bridge();
    expect((await rawRequest(value, { path: "/tools" })).status).toBe(401);
    const response = await rawRequest(value, { path: "/tools", headers: { authorization: `Bearer ${value.token}` } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ instructions: expect.stringContaining("browser_finish"), tools: expect.arrayContaining([expect.objectContaining({ name: "browser_tabs", operation: "tabs.list", readOnly: true, inputSchema: expect.objectContaining({ type: "object" }) })]) });
    const catalog = response.body as { tools: { name: string; inputSchema: { required?: string[] } }[] };
    expect(catalog.tools.find((tool) => tool.name === "browser_open")?.inputSchema.required).toEqual(["url"]);
    expect(JSON.stringify(response.body)).not.toContain(value.token);
  });

  it("rejects extension connections with invalid tokens, website origins, or missing origins", async () => {
    const value = await bridge();
    await expect(connect(value, { token: "wrong" })).rejects.toThrow("401");
    await expect(connect(value, { origin: "https://example.org" })).rejects.toThrow("403");
    await expect(connect(value, { origin: "null" })).rejects.toThrow("403");
    const socket = new WebSocket(`ws://127.0.0.1:${value.port}/extension?token=${value.token}`);
    sockets.push(socket);
    await expect(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); })).rejects.toThrow("403");
    const extension = await connect(value);
    expect(extension.readyState).toBe(WebSocket.OPEN);
  });

  it("requires a compatible hello and refuses another profile without hijacking the first", async () => {
    const value = await bridge();
    const incompatible = await connect(value, { hello: false });
    const closed = new Promise<number>((resolve) => incompatible.once("close", resolve));
    incompatible.send(JSON.stringify({ type: "hello", version: 999, browser: "Chrome" }));
    expect(await closed).toBe(1002);
    const first = await connect(value);
    await expect(connect(value)).rejects.toThrow("409");
    const received = nextCommand(first);
    const response = new BrowserClient(value).execute("session-a", "tabs.list");
    const command = await received;
    first.send(JSON.stringify({ type: "result", id: command.id, result: ["first-profile"] }));
    await expect(response).resolves.toEqual(["first-profile"]);
  });

  it("answers application heartbeats without dispatching browser commands", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const pong = new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
    socket.send(JSON.stringify({ type: "ping" }));
    await expect(pong).resolves.toEqual({ type: "pong" });
    socket.send(JSON.stringify({ type: "pong" }));
    await expect(new BrowserClient(value).status()).resolves.toMatchObject({ connected: true });
  });

  it("correlates concurrent sessions even when results arrive out of order", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const commands: BrowserCommand[] = [];
    const received = new Promise<void>((resolve) => socket.on("message", (data) => { commands.push(JSON.parse(data.toString())); if (commands.length === 2) resolve(); }));
    const client = new BrowserClient(value);
    const first = client.execute("session-a", "tabs.list");
    const second = client.execute("session-b", "tabs.list");
    await received;
    expect(new Set(commands.map((command) => command.id)).size).toBe(2);
    for (const command of commands.toReversed()) socket.send(JSON.stringify({ type: "result", id: command.id, result: { owner: command.sessionId } }));
    await expect(first).resolves.toEqual({ owner: "session-a" });
    await expect(second).resolves.toEqual({ owner: "session-b" });
  });

  it("assigns command deadlines that the HTTP caller cannot extend", async () => {
    const value = await bridge({ requestTimeoutMs: 30_000 });
    const socket = await connect(value);
    const received = nextCommand(socket);
    const before = Date.now();
    const response = rawRequest(value, {
      method: "POST", path: "/command",
      headers: { authorization: `Bearer ${value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "command", id: "caller-selected", sessionId: "session-a", operation: "tabs.list", args: {}, deadlineMs: before + 3_600_000 }),
    });
    const command = await received;
    expect(command.id).not.toBe("caller-selected");
    expect(command.deadlineMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(command.deadlineMs).toBeLessThanOrEqual(Date.now() + 30_000);
    socket.send(JSON.stringify({ type: "result", id: command.id, result: [] }));
    expect((await response).status).toBe(200);
  });

  it("keeps a shorter client deadline so a queued action cannot outlive its caller", async () => {
    const value = await bridge({ requestTimeoutMs: 30_000 });
    const socket = await connect(value);
    const received = nextCommand(socket);
    const before = Date.now();
    const response = new BrowserClient(value, { requestTimeoutMs: 5000 }).execute("session-a", "tabs.navigate", { tabId: 1, url: "https://example.org" });
    const command = await received;
    expect(command.deadlineMs).toBeGreaterThanOrEqual(before + 5000);
    expect(command.deadlineMs).toBeLessThanOrEqual(Date.now() + 5000);
    socket.send(JSON.stringify({ type: "result", id: command.id, result: { navigating: true } }));
    await expect(response).resolves.toEqual({ navigating: true });
  });

  it("rejects already-expired requests before sending an action to the extension", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const commands: unknown[] = [];
    socket.on("message", (data) => commands.push(JSON.parse(data.toString())));
    const response = await rawRequest(value, {
      method: "POST", path: "/command",
      headers: { authorization: `Bearer ${value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", operation: "tabs.close", args: { tabId: 1 }, deadlineMs: Date.now() - 1 }),
    });
    expect(response).toMatchObject({ status: 504, body: { error: { code: "COMMAND_EXPIRED" } } });
    expect(commands).toEqual([]);
  });

  it("expires pending requests on the caller's shorter budget", async () => {
    const value = await bridge({ requestTimeoutMs: 30_000 });
    const socket = await connect(value);
    const received = nextCommand(socket);
    const deadlineMs = Date.now() + 1000;
    const response = rawRequest(value, {
      method: "POST", path: "/command",
      headers: { authorization: `Bearer ${value.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", operation: "tabs.list", args: {}, deadlineMs }),
    });
    expect((await received).deadlineMs).toBe(deadlineMs);
    expect(await response).toMatchObject({ status: 504, body: { error: { code: "TIMEOUT" } } });
  });

  it("rejects pending commands on disconnect and does not replay them to a new extension", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const received = nextCommand(socket);
    const response = new BrowserClient(value).execute("session-a", "tabs.list");
    const outcome = expect(response).rejects.toMatchObject({ code: "EXTENSION_DISCONNECTED" });
    const old = await received;
    socket.terminate();
    await outcome;
    const replacement = await connect(value);
    const newCommand = nextCommand(replacement);
    const next = new BrowserClient(value).execute("session-b", "tabs.list");
    const fresh = await newCommand;
    expect(fresh.id).not.toBe(old.id);
    replacement.send(JSON.stringify({ type: "result", id: old.id, result: "stale" }));
    replacement.send(JSON.stringify({ type: "result", id: fresh.id, result: "fresh" }));
    await expect(next).resolves.toBe("fresh");
  });

  it("times out commands and ignores late responses without corrupting the next result", async () => {
    const value = await bridge({ requestTimeoutMs: 75 });
    const socket = await connect(value);
    const received = nextCommand(socket);
    const response = new BrowserClient(value).execute("session-a", "tabs.list");
    const outcome = expect(response).rejects.toMatchObject({ code: "TIMEOUT" });
    const expired = await received;
    await outcome;
    const nextReceived = nextCommand(socket);
    const next = new BrowserClient(value).execute("session-a", "tabs.list");
    const fresh = await nextReceived;
    socket.send(JSON.stringify({ type: "result", id: expired.id, result: "expired" }));
    socket.send(JSON.stringify({ type: "result", id: fresh.id, result: "fresh" }));
    await expect(next).resolves.toBe("fresh");
  });

  it("validates command envelopes and never dispatches unsupported operations", async () => {
    const value = await bridge();
    const headers = { authorization: `Bearer ${value.token}`, "content-type": "application/json" };
    for (const body of ["{", JSON.stringify({ sessionId: "a", operation: "shell.run", args: {} }), JSON.stringify({ sessionId: "a", operation: "tabs.list", args: [] }), JSON.stringify({ sessionId: "", operation: "tabs.list", args: {} })]) {
      expect((await rawRequest(value, { method: "POST", path: "/command", headers, body })).status).toBe(400);
    }
    expect((await rawRequest(value, { method: "POST", path: "/command", headers: { ...headers, "content-length": String(MAX_MESSAGE_BYTES + 1) }, body: "" })).status).toBe(413);
    await expect(new BrowserClient(value).execute("session-a", "tabs.list")).rejects.toMatchObject({ code: "EXTENSION_DISCONNECTED" });
  });

  it("returns extension errors and screenshot-sized results without leaking credentials", async () => {
    const value = await bridge();
    const socket = await connect(value);
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString()) as BrowserCommand;
      socket.send(JSON.stringify(command.operation === "page.screenshot" ? { type: "result", id: command.id, result: { data: "a".repeat(2 * 1024 * 1024), mimeType: "image/png" } } : { type: "result", id: command.id, error: { code: "TAB_OWNED", message: "This tab belongs to another task." } }));
    });
    const client = new BrowserClient(value);
    await expect(client.execute("session-a", "tabs.claim", { tabId: 4 })).rejects.toMatchObject({ code: "TAB_OWNED" });
    await expect(client.execute("session-a", "page.screenshot", { tabId: 4 })).resolves.toMatchObject({ mimeType: "image/png", data: expect.stringMatching(/^a+$/) });
  });

  it("rejects malformed extension replies and removes the invalid connection", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const received = nextCommand(socket);
    const response = new BrowserClient(value).execute("session-a", "tabs.list");
    const outcome = expect(response).rejects.toMatchObject({ code: "INVALID_EXTENSION_MESSAGE" });
    const command = await received;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "result", id: command.id, result: "success", error: { code: "FAILED", message: "Cannot be success and failure together." } }));
    await outcome;
    expect(await closed).toBe(1002);
    await expect(new BrowserClient(value).status()).resolves.toMatchObject({ connected: false });
  });

  it("does not report success when the extension omits both result and error", async () => {
    const value = await bridge();
    const socket = await connect(value);
    const received = nextCommand(socket);
    const response = new BrowserClient(value).execute("session-a", "tabs.close", { tabId: 1 });
    const outcome = expect(response).rejects.toMatchObject({ code: "INVALID_EXTENSION_MESSAGE" });
    const command = await received;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "result", id: command.id }));
    await outcome;
    expect(await closed).toBe(1002);
  });

  it("cannot bind to a public interface", async () => {
    await expect(startBridge({ host: "0.0.0.0", port: 0 })).rejects.toMatchObject({ code: "LOOPBACK_REQUIRED" });
  });
});
