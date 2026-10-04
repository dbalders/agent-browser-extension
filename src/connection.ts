import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserError, type BrowserConnection } from "./protocol.js";

export function connectionDirectory(root?: string): string {
  return resolve(root ?? process.env.AGENT_BROWSER_HOME ?? join(homedir(), ".agent-browser-extension"));
}

export function validConnection(value: unknown): value is BrowserConnection {
  if (typeof value !== "object" || value === null) return false;
  const { port, token } = value as Partial<BrowserConnection>;
  return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535 &&
    typeof token === "string" && /^[\x21-\x7e]{32,256}$/.test(token);
}

export async function saveConnection(connection: BrowserConnection, root?: string): Promise<void> {
  if (!validConnection(connection)) throw new BrowserError("INVALID_CONNECTION", "Invalid browser bridge connection.");
  const directory = connectionDirectory(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) {
    throw new BrowserError("INVALID_CONNECTION_DIRECTORY", "The browser connection directory must be a real directory.");
  }
  await chmod(directory, 0o700);
  const temporary = join(directory, `.connection-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ port: connection.port, token: connection.token }) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, "connection.json"));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function loadConnection(root?: string): Promise<BrowserConnection> {
  const directory = connectionDirectory(root);
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)) {
      throw new BrowserError("CONNECTION_PERMISSIONS", "The browser connection directory must be private (mode 700).");
    }
    const file = await open(join(directory, "connection.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) throw new BrowserError("INVALID_CONNECTION", "Invalid browser bridge connection file.");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new BrowserError("CONNECTION_PERMISSIONS", "The browser connection file must be private (mode 600).");
      }
      let value: unknown;
      try { value = JSON.parse(await file.readFile("utf8")); }
      catch { throw new BrowserError("INVALID_CONNECTION", "Invalid browser bridge connection file."); }
      if (!validConnection(value)) throw new BrowserError("INVALID_CONNECTION", "Invalid browser bridge connection file.");
      return { port: value.port, token: value.token };
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrowserError("BRIDGE_NOT_CONFIGURED", "Start the agent-browser-extension bridge before connecting an agent.");
    }
    throw error;
  }
}

export async function removeConnection(root?: string): Promise<void> {
  await unlink(join(connectionDirectory(root), "connection.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
