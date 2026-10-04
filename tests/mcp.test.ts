import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserMcpServer, toolResult } from "../src/mcp.js";
import { BrowserError, type BrowserArguments, type BrowserOperation, type BrowserExecutor } from "../src/protocol.js";

async function fixture(fail?: BrowserOperation | BrowserExecutor["execute"]) {
  const calls: { sessionId: string; operation: BrowserOperation; args?: BrowserArguments }[] = [];
  const instance = createBrowserMcpServer({ execute: async (sessionId, operation, args) => {
    calls.push({ sessionId, operation, args });
    if (typeof fail === "function") return fail(sessionId, operation, args);
    if (operation === fail) throw new BrowserError("TAB_BUSY", "This tab belongs to another task.");
    return { ok: true, tabId: 4 };
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(clientTransport);
  return { ...instance, client, calls, close: async () => { await instance.dispose(); await client.close(); await instance.server.close(); } };
}

describe("browser MCP", () => {
  it("exposes explicit activity phases and rejects arbitrary values", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "browser_activity", arguments: { tabId: 4, activity: "researching" } });
      expect(result.isError).not.toBe(true);
      expect(f.calls.at(-1)).toMatchObject({ operation: "tabs.activity", args: { tabId: 4, activity: "researching" } });
      const before = f.calls.length;
      expect((await f.client.callTool({ name: "browser_activity", arguments: { tabId: 4, activity: "custom" } })).isError).toBe(true);
      expect(f.calls).toHaveLength(before);
    } finally { await f.close(); }
  });

  it("lets the agent open a background tab without a tab-selection step", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
      expect(result.isError).not.toBe(true);
      expect(f.calls.map(c => c.operation)).toEqual(["session.start", "tabs.open"]);
      expect(f.calls[1]?.args).toEqual({ url: "https://example.com", background: true });
      expect(f.calls[0]?.sessionId).toBe(f.calls[1]?.sessionId);
    } finally { await f.close(); }
  });
  it("isolates clients and rotates ownership after finishing a task", async () => {
    const first = await fixture(); const second = await fixture();
    try {
      await first.client.callTool({ name: "browser_start", arguments: { name: "Research" } });
      await second.client.callTool({ name: "browser_start", arguments: { name: "Other" } });
      expect(first.calls[0]?.sessionId).not.toBe(second.calls[0]?.sessionId);
      await first.client.callTool({ name: "browser_finish", arguments: {} });
      await first.client.callTool({ name: "browser_start", arguments: { name: "Next" } });
      expect(first.calls.map(c => c.operation)).toEqual(["session.start", "session.end", "session.start"]);
      expect(first.calls[0]?.sessionId).toBe(first.calls[1]?.sessionId);
      expect(first.calls[2]?.sessionId).not.toBe(first.calls[0]?.sessionId);
    } finally { await first.close(); await second.close(); }
  });
  it("returns actionable tool errors and rejects non-web navigation", async () => {
    const f = await fixture("tabs.claim");
    try {
      const busy = await f.client.callTool({ name: "browser_use", arguments: { tabId: 9 } });
      expect(busy.isError).toBe(true);
      expect(JSON.stringify(busy.content)).toContain("TAB_BUSY");
      const invalid = await f.client.callTool({ name: "browser_open", arguments: { url: "file:///etc/passwd" } });
      expect(invalid.isError).toBe(true);
      expect(f.calls.some(c => c.operation === "tabs.open")).toBe(false);
    } finally { await f.close(); }
  });
  it("recovers on the next tool after Chrome forgets a session without replaying the failed action", async () => {
    let active = false;
    let createdTabs = 0;
    const f = await fixture(async (_sessionId, operation) => {
      if (operation === "session.start") { active = true; return { started: true }; }
      if (operation === "session.end") { active = false; return { errors: [] }; }
      if (!active) throw new BrowserError("SESSION_INACTIVE", "Chrome restarted and cleared the browser session.");
      if (operation === "tabs.open") return { tabId: ++createdTabs };
      return { ok: true };
    });
    try {
      expect((await f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com/first" } })).isError).not.toBe(true);
      active = false;
      const failed = await f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com/ambiguous" } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("SESSION_INACTIVE");
      expect(createdTabs).toBe(1);
      expect(f.calls.map((call) => call.operation)).toEqual(["session.start", "tabs.open", "tabs.open"]);
      expect((await f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com/next-request" } })).isError).not.toBe(true);
      expect(createdTabs).toBe(2);
      expect(f.calls.slice(-2).map((call) => call.operation)).toEqual(["session.start", "tabs.open"]);
      expect(f.calls.at(-1)?.args?.url).toBe("https://example.com/next-request");
      expect(new Set(f.calls.map((call) => call.sessionId)).size).toBe(1);
    } finally { await f.close(); }
    expect(f.calls.at(-1)?.operation).toBe("session.end");
  });
  it("does not implicitly restart a user-stopped session", async () => {
    let stopped = false;
    const f = await fixture(async (_sessionId, operation) => {
      if (operation === "session.end") return { errors: [] };
      if (stopped) throw new BrowserError("SESSION_STOPPED", "The user stopped this task.");
      return { ok: true };
    });
    try {
      await f.client.callTool({ name: "browser_start", arguments: { name: "Stop test" } });
      stopped = true;
      for (const url of ["https://example.com/first", "https://example.com/second"]) {
        const result = await f.client.callTool({ name: "browser_open", arguments: { url } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("SESSION_STOPPED");
      }
      expect(f.calls.map((call) => call.operation)).toEqual(["session.start", "tabs.open", "tabs.open"]);
    } finally { await f.close(); }
  });
  it("cleans up its active session on disposal", async () => {
    const f = await fixture();
    await f.client.callTool({ name: "browser_tabs", arguments: {} });
    await f.close();
    expect(f.calls.at(-1)?.operation).toBe("session.end");
    await f.dispose();
    expect(f.calls.filter(c => c.operation === "session.end")).toHaveLength(1);
  });
  it.each([
    { name: "browser_start", arguments: { name: "A task" } },
    { name: "browser_open", arguments: { url: "https://example.com" } },
  ])("cleans up an ambiguous session start from $name", async (tool) => {
    const f = await fixture("session.start");
    try {
      expect((await f.client.callTool(tool)).isError).toBe(true);
      await f.dispose();
      expect(f.calls.map((call) => call.operation)).toEqual(["session.start", "session.end"]);
      expect(f.calls[0]?.sessionId).toBe(f.calls[1]?.sessionId);
    } finally { await f.close(); }
  });
  it("preserves ownership after partial cleanup so finishing can be retried", async () => {
    let ends = 0;
    const f = await fixture(async (_sessionId, operation) => operation === "session.end"
      ? { closed: [], errors: ++ends === 1 ? [{ tabId: 4, message: "Tab close failed" }] : [] }
      : { ok: true });
    try {
      await f.client.callTool({ name: "browser_start", arguments: { name: "First" } });
      const failure = await f.client.callTool({ name: "browser_finish", arguments: {} });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure.content)).toContain("CLEANUP_INCOMPLETE");
      const blocked = await f.client.callTool({ name: "browser_start", arguments: { name: "Would hide unfinished cleanup" } });
      expect(blocked.isError).toBe(true);
      expect(f.calls.map((call) => call.operation)).toEqual(["session.start", "session.end"]);
      expect((await f.client.callTool({ name: "browser_finish", arguments: {} })).isError).not.toBe(true);
      expect(f.calls[0]?.sessionId).toBe(f.calls[2]?.sessionId);
      await f.client.callTool({ name: "browser_start", arguments: { name: "Next" } });
      expect(f.calls[3]?.sessionId).not.toBe(f.calls[0]?.sessionId);
    } finally { await f.close(); }
  });
  it("retries cleanup after a lost finish response without changing the session ID", async () => {
    let ends = 0;
    const f = await fixture(async (_sessionId, operation) => {
      if (operation === "session.end" && ++ends === 1) throw new BrowserError("TIMEOUT", "Reply lost");
      return { ok: true };
    });
    try {
      await f.client.callTool({ name: "browser_start", arguments: { name: "First" } });
      expect((await f.client.callTool({ name: "browser_finish", arguments: {} })).isError).toBe(true);
      expect((await f.client.callTool({ name: "browser_finish", arguments: {} })).isError).not.toBe(true);
      expect(f.calls[0]?.sessionId).toBe(f.calls[1]?.sessionId);
      expect(f.calls[1]?.sessionId).toBe(f.calls[2]?.sessionId);
    } finally { await f.close(); }
  });
  it("encodes screenshot images separately and bounds text output", () => {
    expect(toolResult({ dataUrl: "data:image/png;base64,YWJj", width: 20 }).content).toEqual([
      { type: "text", text: '{"width":20}' }, { type: "image", mimeType: "image/png", data: "YWJj" },
    ]);
    expect(toolResult("x".repeat(120_001)).isError).toBe(true);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("concurrent MCP tasks", () => {
  it("does not dispatch an aborted same-tab request and preserves later work", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "page.wait") { entered.resolve(); await release.promise; }
      return { ok: true };
    });
    try {
      const waiting = f.client.callTool({ name: "browser_wait", arguments: { tabId: 1 } });
      await entered.promise;
      const cancellation = new AbortController();
      const cancelled = f.client.callTool({ name: "browser_click", arguments: { tabId: 1, selector: "#submit" } }, undefined, { signal: cancellation.signal });
      const rejected = expect(cancelled).rejects.toThrow("Cancelled queued submission");
      const later = f.client.callTool({ name: "browser_read", arguments: { tabId: 1 } });
      await f.client.callTool({ name: "browser_read", arguments: { tabId: 2 } });
      expect(f.calls.some(call => call.operation === "page.click")).toBe(false);
      cancellation.abort(new Error("Cancelled queued submission"));
      await rejected;
      release.resolve(); await Promise.all([waiting, later]);
      expect(f.calls.some(call => call.operation === "page.click")).toBe(false);
      expect(f.calls.filter(call => call.operation === "page.read").map(call => call.args?.tabId)).toEqual([2, 1]);
    } finally { release.resolve(); await f.close(); }
  });
  it("does not dispatch a queued request after the MCP client deadline expires", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "page.wait") { entered.resolve(); await release.promise; }
      return { ok: true };
    });
    try {
      const waiting = f.client.callTool({ name: "browser_wait", arguments: { tabId: 1 } });
      await entered.promise;
      vi.useFakeTimers();
      const expired = f.client.callTool({ name: "browser_click", arguments: { tabId: 1, selector: "#submit" } }, undefined, { timeout: 100 });
      const rejected = expect(expired).rejects.toThrow("Request timed out");
      await f.client.callTool({ name: "browser_status", arguments: {} });
      await vi.advanceTimersByTimeAsync(100); await rejected;
      vi.useRealTimers();
      release.resolve(); await waiting;
      await f.client.callTool({ name: "browser_read", arguments: { tabId: 1 } });
      expect(f.calls.some(call => call.operation === "page.click")).toBe(false);
    } finally { vi.useRealTimers(); release.resolve(); await f.close(); }
  });
  it("rechecks cancellation after shared implicit startup without cancelling another tab", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "session.start") { entered.resolve(); await release.promise; }
      return { ok: true };
    });
    try {
      const cancellation = new AbortController();
      const cancelled = f.client.callTool({ name: "browser_click", arguments: { tabId: 1, selector: "#submit" } }, undefined, { signal: cancellation.signal });
      const rejected = expect(cancelled).rejects.toThrow("Cancelled before startup completed");
      await entered.promise;
      const other = f.client.callTool({ name: "browser_read", arguments: { tabId: 2 } });
      await f.client.callTool({ name: "browser_status", arguments: {} });
      cancellation.abort(new Error("Cancelled before startup completed")); await rejected;
      release.resolve();
      expect((await other).isError).not.toBe(true);
      expect(f.calls.filter(call => call.operation === "session.start")).toHaveLength(1);
      expect(f.calls.some(call => call.operation === "page.click")).toBe(false);
      expect(f.calls.filter(call => call.operation === "page.read").map(call => call.args?.tabId)).toEqual([2]);
    } finally { release.resolve(); await f.close(); }
  });
  it("does not dispatch an action after disposal begins during implicit startup", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "session.start") { entered.resolve(); await release.promise; }
      return { errors: [] };
    });
    try {
      const opening = f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
      await entered.promise;
      const disposed = f.dispose();
      release.resolve();
      const result = await opening;
      await disposed;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("SESSION_CLOSED");
      expect(f.calls.map(call => call.operation)).toEqual(["session.start", "session.end"]);
      expect(f.calls[1]?.sessionId).toBe(f.calls[0]?.sessionId);
    } finally { release.resolve(); await f.close(); }
  });
  it("runs separate tabs together while preserving same-tab order", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation, args) => {
      if (operation === "page.wait") { entered.resolve(); await release.promise; }
      return { ok: true, tabId: args?.tabId };
    });
    try {
      const waiting = f.client.callTool({ name: "browser_wait", arguments: { tabId: 1 } });
      await entered.promise;
      const sameTab = f.client.callTool({ name: "browser_read", arguments: { tabId: 1 } });
      const otherTab = await f.client.callTool({ name: "browser_read", arguments: { tabId: 2 } });
      expect(otherTab.isError).not.toBe(true);
      expect(f.calls.filter(call => call.operation === "page.read").map(call => call.args?.tabId)).toEqual([2]);
      release.resolve();
      await Promise.all([waiting, sameTab]);
      expect(f.calls.filter(call => call.operation === "page.read").map(call => call.args?.tabId)).toEqual([2, 1]);
    } finally { release.resolve(); await f.close(); }
  });
  it("shares one implicit session startup among concurrent tools", async () => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "session.start") { entered.resolve(); await release.promise; }
      return { ok: true };
    });
    try {
      const first = f.client.callTool({ name: "browser_read", arguments: { tabId: 1 } });
      const second = f.client.callTool({ name: "browser_read", arguments: { tabId: 2 } });
      await entered.promise;
      await f.client.callTool({ name: "browser_status", arguments: {} });
      expect(f.calls.filter(call => call.operation === "session.start")).toHaveLength(1);
      expect(f.calls.some(call => call.operation === "page.read")).toBe(false);
      release.resolve(); await Promise.all([first, second]);
      expect(new Set(f.calls.map(call => call.sessionId)).size).toBe(1);
    } finally { release.resolve(); await f.close(); }
  });
  it("drains actions before finish and holds subsequent work until cleanup completes", async () => {
    const entered = deferred(); const release = deferred();
    const ending = deferred(); const finishRelease = deferred();
    const f = await fixture(async (_session, operation) => {
      if (operation === "page.wait") { entered.resolve(); await release.promise; }
      if (operation === "session.end") { ending.resolve(); await finishRelease.promise; }
      return { errors: [] };
    });
    try {
      const first = f.client.callTool({ name: "browser_wait", arguments: { tabId: 1 } });
      await entered.promise;
      const finish = f.client.callTool({ name: "browser_finish", arguments: {} });
      const later = f.client.callTool({ name: "browser_open", arguments: { url: "https://example.com" } });
      release.resolve(); await ending.promise;
      expect(f.calls.some(call => call.operation === "tabs.open")).toBe(false);
      finishRelease.resolve(); await Promise.all([first, finish, later]);
      expect(f.calls.map(call => call.operation)).toEqual(["session.start", "page.wait", "session.end", "session.start", "tabs.open"]);
      expect(f.calls[4]?.sessionId).not.toBe(f.calls[1]?.sessionId);
    } finally { release.resolve(); finishRelease.resolve(); await f.close(); }
  });
});
