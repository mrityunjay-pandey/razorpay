import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_NAMES } from "../src/mcp/tools.js";

/**
 * End-to-end over a real child process and real stdio, exactly how an MCP host
 * launches the connector. Only invalid calls are made, so no network is used,
 * and the environment is built from scratch so a developer's .env is never read.
 */
const SERVER = ["--import", "tsx", "src/index.ts"];
const FAKE_ENV = { FRESHDESK_DOMAIN: "acme-test", FRESHDESK_API_KEY: "fakeKeyForStdioTest" };

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("stdio entry point", () => {
  it("serves MCP over stdio with nothing but protocol messages on stdout", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: SERVER,
      env: { ...getDefaultEnvironment(), ...FAKE_ENV },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    // Any non-JSON-RPC byte on stdout would make the client fail to parse and reject here.
    client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    const result = (await client.callTool({ name: "get_ticket", arguments: { ticket_id: 0 } })) as CallToolResult;
    expect(result.isError).toBe(true);

    expect(stderr).toContain('"event":"server_started"');
    expect(stderr).not.toContain(FAKE_ENV.FRESHDESK_API_KEY);
  }, 20_000);

  it("refuses to start without configuration and explains what is missing", () => {
    const env = { ...getDefaultEnvironment() };
    const run = spawnSync(process.execPath, SERVER, { env, encoding: "utf8", input: "", timeout: 15_000 });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("FRESHDESK_DOMAIN is not set");
    expect(run.stderr).toContain("FRESHDESK_API_KEY is not set");
  }, 20_000);
});
