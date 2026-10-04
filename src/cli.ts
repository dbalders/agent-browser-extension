#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBridge } from "./bridge.js";
import { BrowserClient } from "./client.js";
import { loadConnection, saveConnection, removeConnection, connectionDirectory } from "./connection.js";
import { createBrowserMcpServer } from "./mcp.js";
import { BrowserError, DEFAULT_PORT } from "./protocol.js";

const usage = `agent-browser-extension

  agent-browser-extension serve [--port 43187] [--home <directory>]
  agent-browser-extension pair [--home <directory>]
  agent-browser-extension status [--home <directory>]
  agent-browser-extension mcp [--home <directory>]
  agent-browser-extension setup [--home <directory>]

serve  Run the local bridge. Keep it running while agents use Chrome.
pair   Display the connection code for the extension's Connect screen.
status Check whether Chrome is connected.
mcp    Expose autonomous browser tools to an MCP client over stdio.
setup  Print the extension folder and MCP client configuration.
`;

async function main() {
  const { values, positionals } = parseArgs({ options: { port: { type: "string" }, home: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
  const command = positionals[0];
  if (values.help || !command) { process.stdout.write(usage); return; }
  const home = values.home;
  if (command === "serve") {
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer between 1 and 65535.");
    // Reuse a paired token across ordinary bridge restarts so Chrome can reconnect.
    const previous = await loadConnection(home).catch((error: unknown) => {
      if (error instanceof BrowserError && error.code === "BRIDGE_NOT_CONFIGURED") return undefined;
      throw error;
    });
    const bridge = await startBridge({ port, ...(previous ? { token: previous.token } : {}) });
    await saveConnection({ port: bridge.port, token: bridge.token }, home).catch(async (error: unknown) => { await bridge.close(); throw error; });
    process.stderr.write(`agent-browser-extension bridge listening on 127.0.0.1:${bridge.port}.\nRun "agent-browser-extension pair" to connect the extension.\n`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await bridge.close();
      // Preserve pairing across restarts. Never remove the connection file here.
    };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
    return;
  }
  if (command === "pair") {
    const connection = await loadConnection(home);
    process.stdout.write(`Open the agent-browser-extension extension and enter:\n\nPort: ${connection.port}\nConnection code: ${connection.token}\n\nThis code grants local browser access. Keep it private.\n`);
    return;
  }
  if (command === "status") {
    const client = new BrowserClient(await loadConnection(home));
    process.stdout.write(`${JSON.stringify(await client.status(), null, 2)}\n`);
    return;
  }
  if (command === "mcp") {
    const client = new BrowserClient(await loadConnection(home));
    const { server, dispose } = createBrowserMcpServer(client);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await dispose().catch((error: unknown) => {
        process.stderr.write(`Browser cleanup: ${error instanceof Error ? error.message : "failed"}\n`);
        process.exitCode = 1;
      });
      await server.close();
    };
    const requestStop = () => { void stop().catch((error: unknown) => {
      process.stderr.write(`Browser shutdown: ${error instanceof Error ? error.message : "failed"}\n`);
      process.exitCode = 1;
    }); };
    server.server.onclose = requestStop;
    // The SDK stdio transport does not emit onclose when its input reaches EOF.
    // Agents normally close stdin when ending a subprocess, so handle it directly.
    process.stdin.once("end", requestStop);
    process.stdin.once("close", requestStop);
    process.stdout.once("error", requestStop);
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === "setup") {
    process.stdout.write(`Load this folder as an unpacked extension in chrome://extensions:\n${fileURLToPath(new URL("./extension/", import.meta.url))}\n\nMCP client configuration:\n${JSON.stringify({ mcpServers: { "agent-browser-extension": { command: process.execPath, args: [fileURLToPath(import.meta.url), "mcp", "--home", connectionDirectory(home)] } } }, null, 2)}\n`);
    return;
  }
  if (command === "forget") {
    await removeConnection(home);
    process.stdout.write("Removed the saved local connection. Stop the bridge and disconnect the extension to revoke a live connection.\n");
    return;
  }
  throw new Error(`Unknown command: ${command}.\n${usage}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "agent-browser-extension failed."}\n`);
  process.exitCode = 1;
});
