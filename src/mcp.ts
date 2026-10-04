import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BrowserError, type BrowserExecutor, type BrowserArguments } from "./protocol.js";
import { BROWSER_INSTRUCTIONS, browserTools } from "./tools.js";

export function toolResult(value: unknown): CallToolResult {
  if (typeof value === "object" && value !== null && "mimeType" in value && "data" in value &&
    (value.mimeType === "image/png" || value.mimeType === "image/jpeg") && typeof value.data === "string") {
    const { data, mimeType, ...metadata } = value;
    return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", mimeType, data }] };
  }
  if (typeof value === "object" && value !== null && "dataUrl" in value && typeof value.dataUrl === "string") {
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value.dataUrl);
    if (match?.[1] && match[2]) {
      const { dataUrl: _dataUrl, ...metadata } = value;
      return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", mimeType: match[1], data: match[2] }] };
    }
  }
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) > 120_000) {
    return { isError: true, content: [{ type: "text", text: "The browser result exceeded 120 KB. Narrow the extraction and retry." }] };
  }
  return { content: [{ type: "text", text }] };
}

export function createBrowserMcpServer(executor: BrowserExecutor) {
  const server = new McpServer({ name: "agent-browser-extension", version: "0.1.0" }, { instructions: BROWSER_INSTRUCTIONS });
  let sessionId = randomUUID();
  let started = false;
  let needsCleanup = false;
  let cleanupIncomplete = false;
  let closing = false;
  let barrier: Promise<unknown> = Promise.resolve();
  let starting: Promise<void> | undefined;
  const running = new Set<Promise<void>>();
  const tabs = new Map<number, Promise<void>>();

  // Lifecycle requests fence prior work and later requests. Independent tabs
  // otherwise run concurrently, preserving order for one tab even over HTTP.
  const schedule = <T>(action: () => Promise<T>, exclusive = false, tabId?: unknown): Promise<T> => {
    const dependencies: Promise<unknown>[] = [barrier];
    const key = typeof tabId === "number" && Number.isSafeInteger(tabId) ? tabId : undefined;
    if (exclusive) dependencies.push(...running);
    else if (key !== undefined && tabs.has(key)) dependencies.push(tabs.get(key)!);
    const next = Promise.allSettled(dependencies).then(action);
    const settled = next.then(() => undefined, () => undefined);
    running.add(settled);
    if (exclusive) barrier = settled;
    else if (key !== undefined) tabs.set(key, settled);
    void settled.then(() => {
      running.delete(settled);
      if (key !== undefined && tabs.get(key) === settled) tabs.delete(key);
    });
    return next;
  };
  const ensureStarted = async () => {
    if (started) return;
    if (!starting) {
      needsCleanup = true;
      starting = executor.execute(sessionId, "session.start", { name: "Browser task" })
        .then(() => { started = true; })
        .finally(() => { starting = undefined; });
    }
    await starting;
  };
  const finish = async () => {
    if (!needsCleanup) return { finished: true };
    cleanupIncomplete = true;
    const result = await executor.execute(sessionId, "session.end", {});
    if (typeof result === "object" && result !== null && "errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
      throw new BrowserError("CLEANUP_INCOMPLETE", `${result.errors.length} browser tab(s) could not be cleaned up. Call browser_finish again to retry; this task's ownership has been preserved.`);
    }
    started = false;
    needsCleanup = false;
    cleanupIncomplete = false;
    sessionId = randomUUID();
    return result;
  };

  for (const tool of browserTools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: { readOnlyHint: tool.readOnly === true, destructiveHint: tool.readOnly !== true, openWorldHint: true },
    }, async (args, request) => schedule(async () => {
      try {
        if (request.signal.aborted) throw new BrowserError("REQUEST_CANCELLED", "This browser request was cancelled before dispatch.");
        if (closing) throw new BrowserError("SESSION_CLOSED", "This browser agent connection is closing.");
        if (tool.operation === "session.end") return toolResult(await finish());
        if (tool.operation === "status") return toolResult(await executor.execute(sessionId, "status", {}));
        if (cleanupIncomplete) throw new BrowserError("CLEANUP_INCOMPLETE", "Call browser_finish again to complete cleanup before starting another browser task.");
        if (tool.operation === "session.start") {
          // A lost reply does not prove the browser failed to create the session.
          needsCleanup = true;
          const result = await executor.execute(sessionId, "session.start", args as BrowserArguments);
          started = true;
          return toolResult(result);
        }
        await ensureStarted();
        if (request.signal.aborted) throw new BrowserError("REQUEST_CANCELLED", "This browser request was cancelled before dispatch.");
        if (closing) throw new BrowserError("SESSION_CLOSED", "This browser agent connection is closing.");
        return toolResult(await executor.execute(sessionId, tool.operation, args as BrowserArguments));
      } catch (error) {
        // Chrome may restart and forget extension sessions while this MCP process
        // stays alive. Let the next explicit tool call establish its session;
        // never replay the failed action or reset a user-stopped session.
        if (error instanceof BrowserError && error.code === "SESSION_INACTIVE") started = false;
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: error instanceof BrowserError ? error.code : "BROWSER_ERROR", message: error instanceof Error ? error.message : "Browser operation failed." }) }],
        };
      }
    }, tool.operation === "session.start" || tool.operation === "session.end", (args as BrowserArguments).tabId));
  }
  return { server, dispose: () => { closing = true; return schedule(finish, true); } };
}
