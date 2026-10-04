import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { BrowserClient } from "../src/client.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function clientForResponse(body: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return new BrowserClient({ port: address.port, token: "a".repeat(43) });
}

it("rejects a contradictory success and error response instead of trusting either half", async () => {
  const client = await clientForResponse(JSON.stringify({ result: { closed: true }, error: { code: "FAILED", message: "Did not close" } }));
  await expect(client.execute("task", "tabs.close", { tabId: 1 })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it("distinguishes an explicit null result from a missing result", async () => {
  await expect((await clientForResponse('{"result":null}')).status()).resolves.toBeNull();
  await expect((await clientForResponse('{}')).status()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
