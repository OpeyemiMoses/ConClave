import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";

// Stdio transport — for local testing with an MCP client (Claude Desktop,
// mcp inspector, etc). The actual OKX A2MCP listing points at the
// Streamable HTTP endpoint in server.js instead (POST /mcp), not this file.
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[ConClave MCP] stdio server ready");
