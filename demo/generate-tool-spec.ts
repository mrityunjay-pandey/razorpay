import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../src/mcp/server.js";
import type { ConnectorServices } from "../src/mcp/tools.js";

export const SPEC_PATH = "docs/mcp-tools.json";

/**
 * Produces the MCP tool specification exactly as the server advertises it via
 * tools/list (names, descriptions, input/output JSON Schemas, annotations).
 * Generated, never hand-written, so it cannot drift from the code.
 */
export async function generateToolSpec(): Promise<string> {
  const unused = () => Promise.reject(new Error("not called during tools/list"));
  const services: ConnectorServices = {
    tickets: { get: unused, list: unused, search: unused },
    contacts: { get: unused, search: unused },
  };
  const server = createServer(services);
  const client = new Client({ name: "spec-generator", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const { tools } = await client.listTools();
  const spec = {
    server: { name: SERVER_NAME, version: SERVER_VERSION, transport: "stdio" },
    instructions: client.getInstructions(),
    tools,
  };
  await client.close();
  return `${JSON.stringify(spec, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(SPEC_PATH, await generateToolSpec());
  process.stderr.write(`Wrote ${SPEC_PATH}\n`);
}
