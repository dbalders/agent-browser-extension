import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { browserTools, BROWSER_INSTRUCTIONS } from "../dist/tools.js";
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/catalog.json", import.meta.url), `${JSON.stringify({
  protocolVersion: 1,
  instructions: BROWSER_INSTRUCTIONS,
  tools: browserTools.map(tool => ({ name: tool.name, description: tool.description, operation: tool.operation, readOnly: tool.readOnly === true, inputSchema: z.toJSONSchema(tool.schema, { io: "input" }) })),
}, null, 2)}\n`);
