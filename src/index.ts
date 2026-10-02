#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { FreshdeskClient } from "./freshdesk/client.js";
import { ContactService } from "./freshdesk/contacts.js";
import { TicketService } from "./freshdesk/tickets.js";
import { stderrLogger } from "./logger.js";
import { createServer } from "./mcp/server.js";

// stdout carries MCP JSON-RPC messages, so all diagnostics go to stderr.
async function main(): Promise<void> {
  // Fail fast at startup rather than on the agent's first tool call.
  const config = loadConfig();
  const client = new FreshdeskClient(config, { logger: stderrLogger });
  const server = createServer(
    { tickets: new TicketService(client), contacts: new ContactService(client) },
    stderrLogger,
  );
  await server.connect(new StdioServerTransport());
  stderrLogger("info", "server_started", { transport: "stdio", baseUrl: config.baseUrl });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    stderrLogger("error", "fatal_startup_error", { reason: error instanceof Error ? error.message : String(error) });
  }
  process.exit(1);
});
