import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runPipeline } from "./pipeline.js";
import { toMarkdown } from "./report.js";

/**
 * Builds a fresh McpServer with analyze_repo/reanalyze_repo registered.
 * Called per-connection (stdio) or per-request (stateless HTTP) — cheap,
 * since it's just closures over the shared pipeline, no state here.
 */
export function createMcpServer() {
  const server = new McpServer({ name: "conclave", version: "0.1.0" });

  server.tool(
    "analyze_repo",
    "Runs 4 specialist AI agents (architecture, security, dependencies, onboarding) against a " +
      "GitHub repo, then synthesizes their findings into one report. Re-running on the same repo " +
      "automatically uses diff-aware memory to skip unaffected agents and flag invalidated conclusions.",
    { url: z.string().describe("GitHub repo URL, e.g. https://github.com/owner/repo") },
    async ({ url }) => {
      const result = await runPipeline(url);
      return { content: [{ type: "text", text: toMarkdown(result) }] };
    }
  );

  // Same underlying pipeline (it auto-detects first-run vs re-run via stored
  // memory) — exposed as a distinct tool name so callers can express intent.
  server.tool(
    "reanalyze_repo",
    "Re-runs ConClave analysis on a previously-analyzed repo. Only agents whose area was touched " +
      "by the diff are re-run; others reuse cached findings. Synthesis explicitly states which prior " +
      "conclusions are now invalid.",
    { url: z.string().describe("GitHub repo URL previously passed to analyze_repo") },
    async ({ url }) => {
      const result = await runPipeline(url);
      return { content: [{ type: "text", text: toMarkdown(result) }] };
    }
  );

  return server;
}
