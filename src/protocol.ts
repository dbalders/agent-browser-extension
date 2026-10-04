export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 43187;
export const OPERATIONS = [
  "status", "access.status", "session.start", "session.end", "session.list", "tabs.list", "tabs.open",
  "tabs.claim", "tabs.activity", "tabs.release", "tabs.close", "tabs.mark", "tabs.show", "tabs.navigate",
  "groups.update", "page.frames", "page.snapshot", "page.click", "page.hover", "page.drag", "page.select", "page.type", "page.history", "page.fill", "page.press", "page.scroll",
  "page.profile", "page.performance", "page.inspect", "page.read", "page.check", "page.console", "page.network", "page.emulate", "page.evaluate", "page.screenshot", "page.wait", "page.upload", "page.dialog",
  "downloads.list", "downloads.wait"
] as const;
export type BrowserOperation = (typeof OPERATIONS)[number];
export type BrowserArguments = Record<string, unknown>;
export interface BrowserCommand {
  type: "command";
  id: string;
  sessionId: string;
  operation: BrowserOperation;
  args: BrowserArguments;
  /** Unix time in milliseconds, bounded by the caller and bridge timeouts. Queued actions must not start after this deadline. */
  deadlineMs?: number;
}
export interface BrowserResult {
  type: "result";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface BrowserHello {
  type: "hello";
  version: number;
  browser: string;
  profile?: string;
}
export interface BrowserConnection {
  port: number;
  token: string;
}
export interface BrowserExecutor {
  execute(sessionId: string, operation: BrowserOperation, args?: BrowserArguments): Promise<unknown>;
}
export class BrowserError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BrowserError"; }
}
