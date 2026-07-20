import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { runPipeline } from "./pipeline.js";
import { toMarkdown } from "./report.js";
import { createJob, getJob, runJobInBackground } from "./jobs.js";

/**
 * Builds a fresh McpServer with analyze_repo/reanalyze_repo/check_job_status
 * registered. Called per-connection (stdio) or per-request (stateless HTTP)
 * — cheap, since it's just closures over the shared pipeline, no state here
 * (the job store itself lives in jobs.js, shared across connections).
 *
 * analyze_repo/reanalyze_repo return a jobId immediately instead of blocking
 * on the full 4-agent pipeline (30-90s+, longer under provider rate
 * limiting) — a synchronous MCP tools/call that slow risks the caller (or
 * any proxy/timeout in front of it) giving up before a response ever
 * arrives. check_job_status is how the caller retrieves the result once
 * ready.
 */
export function createMcpServer() {
  const server = new McpServer({ name: "conclave", version: "0.1.0" });

  server.tool(
    "analyze_repo",
    "Starts a 4-specialist AI audit (architecture, security, dependencies, onboarding) of a GitHub " +
      "repo, synthesized into one report. Returns a jobId immediately — the analysis itself takes " +
      "30-90s; call check_job_status with the jobId to retrieve the result. Re-running on the same " +
      "repo automatically uses diff-aware memory to skip unaffected agents and flag invalidated conclusions.",
    { url: z.string().describe("GitHub repo URL, e.g. https://github.com/owner/repo") },
    async ({ url }) => {
      const jobId = createJob({ format: "markdown" });
      runJobInBackground(jobId, () => runPipeline(url));
      return {
        content: [{
          type: "text",
          text: `Analysis started (jobId: ${jobId}). Call check_job_status with this jobId in ~30-90s to get the result.`
        }]
      };
    }
  );

  // Same underlying pipeline (it auto-detects first-run vs re-run via stored
  // memory) — exposed as a distinct tool name so callers can express intent.
  server.tool(
    "reanalyze_repo",
    "Starts a re-run of ConClave analysis on a previously-analyzed repo. Returns a jobId immediately; " +
      "call check_job_status to retrieve the result. Only agents whose area was touched by the diff " +
      "are re-run; others reuse cached findings. Synthesis explicitly states which prior conclusions " +
      "are now invalid.",
    { url: z.string().describe("GitHub repo URL previously passed to analyze_repo") },
    async ({ url }) => {
      const jobId = createJob({ format: "markdown" });
      runJobInBackground(jobId, () => runPipeline(url));
      return {
        content: [{
          type: "text",
          text: `Re-analysis started (jobId: ${jobId}). Call check_job_status with this jobId in ~30-90s to get the result.`
        }]
      };
    }
  );

  server.tool(
    "check_job_status",
    "Checks the status of an analyze_repo/reanalyze_repo job. Returns the full report once done.",
    { jobId: z.string().describe("The jobId returned by analyze_repo or reanalyze_repo") },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (!job) return { content: [{ type: "text", text: `Unknown jobId: ${jobId}` }] };
      if (job.status === "processing") {
        return { content: [{ type: "text", text: "Still processing — try again shortly." }] };
      }
      if (job.status === "failed") {
        return { content: [{ type: "text", text: `Analysis failed: ${job.error}` }] };
      }
      return { content: [{ type: "text", text: toMarkdown(job.result) }] };
    }
  );

  return server;
}
