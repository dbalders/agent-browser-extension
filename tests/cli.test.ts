import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import { startBridge, type RunningBridge } from "../src/bridge.js";
import { saveConnection } from "../src/connection.js";
import type { BrowserCommand } from "../src/protocol.js";

const bridges: RunningBridge[] = [];
const sockets: WebSocket[] = [];
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("cleans up temporary browser tabs when an MCP subprocess receives stdin EOF", async () => {
  const bridge = await startBridge({ port: 0 });
  bridges.push(bridge);
  const root = await mkdtemp(join(tmpdir(), "agent-browser-cli-eof-"));
  roots.push(root);
  await saveConnection(bridge, root);
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension?token=${bridge.token}`, { origin: `chrome-extension://${"a".repeat(32)}` });
  sockets.push(socket);
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", version: 1, browser: "Chrome" }));
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
  const commands: BrowserCommand[] = [];
  socket.on("message", (data) => {
    const command = JSON.parse(data.toString()) as BrowserCommand;
    commands.push(command);
    socket.send(JSON.stringify({ type: "result", id: command.id, result: command.operation === "session.end"
      ? { closed: [4], retained: [], released: [], errors: [] }
      : { sessionId: command.sessionId, tabId: 4 } }));
  });
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "mcp", "--home", root], { cwd: process.cwd(), stdio: "pipe" });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const replies = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (typeof value.id === "number") { replies.get(value.id)?.(value); replies.delete(value.id); }
  });
  let requestId = 0;
  const send = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++requestId;
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const initialized = await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-agent", version: "1" } });
  expect(initialized.error).toBeUndefined();
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const opened = await send("tools/call", { name: "browser_open", arguments: { url: "https://example.com" } });
  expect(opened.result.isError).not.toBe(true);
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
  child.stdin.end();
  expect(await exited).toEqual([0, null]);
  expect(stderr).toBe("");
  expect(commands.map((command) => command.operation)).toEqual(["session.start", "tabs.open", "session.end"]);
  expect(new Set(commands.map((command) => command.sessionId)).size).toBe(1);
}, 10_000);
