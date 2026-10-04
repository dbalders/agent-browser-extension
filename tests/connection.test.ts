import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionDirectory, loadConnection, removeConnection, saveConnection } from "../src/connection.js";

const roots: string[] = [];
const connection = { port: 43187, token: "a".repeat(43) };
async function root() { const directory = await mkdtemp(join(tmpdir(), "agent-browser-connection-test-")); roots.push(directory); return directory; }
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("private bridge connections", () => {
  it("saves and replaces a connection with private filesystem permissions", async () => {
    const directory = join(await root(), "connection");
    await saveConnection(connection, directory);
    expect(await loadConnection(directory)).toEqual(connection);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "connection.json"))).mode & 0o777).toBe(0o600);
    }
    const replacement = { ...connection, port: 43188, token: "b".repeat(43) };
    await saveConnection(replacement, directory);
    expect(await loadConnection(directory)).toEqual(replacement);
    await removeConnection(directory);
    await expect(loadConnection(directory)).rejects.toMatchObject({ code: "BRIDGE_NOT_CONFIGURED" });
    await removeConnection(directory);
  });

  it("uses a configurable home without touching user configuration", async () => {
    const directory = await root();
    const previous = process.env.AGENT_BROWSER_HOME;
    process.env.AGENT_BROWSER_HOME = directory;
    try {
      expect(connectionDirectory()).toBe(directory);
      await saveConnection(connection);
      expect(await loadConnection()).toEqual(connection);
    } finally {
      if (previous === undefined) delete process.env.AGENT_BROWSER_HOME;
      else process.env.AGENT_BROWSER_HOME = previous;
    }
  });

  it("rejects malformed files and non-private files", async () => {
    const directory = await root();
    await saveConnection(connection, directory);
    await writeFile(join(directory, "connection.json"), "{bad json");
    await expect(loadConnection(directory)).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    await saveConnection(connection, directory);
    if (process.platform !== "win32") {
      await chmod(join(directory, "connection.json"), 0o644);
      await expect(loadConnection(directory)).rejects.toMatchObject({ code: "CONNECTION_PERMISSIONS" });
    }
    await expect(saveConnection({ port: 0, token: "short" }, directory)).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
  });

  it("rejects symlinked credential files and replaces symlinks instead of writing their targets", async () => {
    const directory = await root();
    const target = join(directory, "keep.json");
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, join(directory, "connection.json"));
    await expect(loadConnection(directory)).rejects.toThrow();
    await saveConnection(connection, directory);
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect(await loadConnection(directory)).toEqual(connection);
  });
});
