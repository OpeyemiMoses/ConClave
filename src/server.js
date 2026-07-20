import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { runPipeline } from "./pipeline.js";
import { toMarkdown } from "./report.js";
import { createMcpServer } from "./mcp.js";
import { createJob, getJob, runJobInBackground } from "./jobs.js";

const app = express();
// Trust proxy is required to reconstruct the correct https:// protocol
// in the x402 payment challenges when running behind edge proxies (like Railway)
app.set("trust proxy", true);

app.use(express.json());

// Force Accept header for /mcp requests so MCP transport handles them
// correctly even if clients (like task-402-pay) do not send standard headers.
app.use((req, res, next) => {
  if (req.path.includes("mcp")) {
    req.headers["accept"] = "application/json, text/event-stream";
    if (req.rawHeaders) {
      const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === "accept");
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = "application/json, text/event-stream";
      } else {
        req.rawHeaders.push("Accept", "application/json, text/event-stream");
      }
    }
  }
  next();
});

// Defaults to X Layer TESTNET per OKX docs — flip to mainnet once you've
// verified an end-to-end paid call. Prices are USD strings and the SDK
// auto-converts to the network's stablecoin, so no other changes needed
// when you switch.
const NETWORK = process.env.X402_NETWORK || "eip155:1952"; // eip155:196 = mainnet
const PAY_TO = process.env.PAY_TO_ADDRESS;
// One price for every call — analyze_repo, reanalyze_repo, and /mcp all
// charge the same, matching OKX's one-price-per-call A2MCP registration
// model (it doesn't support per-tool pricing on a single listing anyway).
const PRICE = process.env.X402_PRICE_MCP_CALL || "$0.50";

let resourceServer = null;
let mcpPaymentGate = null;
if (process.env.OKX_API_KEY && PAY_TO) {
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
  });
  resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(NETWORK, new ExactEvmScheme());

  app.use(
    paymentMiddleware(
      {
        "POST /analyze_repo": {
          accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: PRICE, extra: { decimals: 6 } }],
          description: "ConClave: multi-agent repo analysis (first run)",
          mimeType: "application/json",
        },
        "POST /reanalyze_repo": {
          accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: PRICE, extra: { decimals: 6 } }],
          description: "ConClave: diff-aware repo re-analysis",
          mimeType: "application/json",
        },
      },
      resourceServer
    )
  );

  // /mcp needs its own gate, applied conditionally — paymentMiddleware only
  // understands HTTP method+path, but a single POST /mcp route carries many
  // different JSON-RPC methods (initialize, tools/list, tools/call, ...).
  // Charging for all of them would charge for tool DISCOVERY, which breaks
  // every MCP client (including OKX's own registration flow) — they need to
  // call tools/list for free before ever deciding to pay for a tools/call.
  mcpPaymentGate = paymentMiddleware(
    {
      "GET /mcp": {
        accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: PRICE, extra: { decimals: 6 } }],
        description: "ConClave MCP endpoint check",
        mimeType: "application/json",
      },
      "POST /mcp": {
        accepts: [{ scheme: "exact", network: NETWORK, payTo: PAY_TO, price: PRICE, extra: { decimals: 6 } }],
        description: "ConClave MCP endpoint (analyze_repo / reanalyze_repo)",
        mimeType: "application/json",
      },
    },
    resourceServer
  );
} else {
  console.warn(
    "[ConClave] OKX_API_KEY / PAY_TO_ADDRESS not set — running WITHOUT payment gating. " +
      "Fine for local testing, not for the ASP listing."
  );
}

app.get("/health", (_req, res) => res.json({ status: "ok", updated: "accept-fix-v2" }));

// The pipeline runs 4 LLM agents (30-90s+, longer under provider rate
// limiting) — too slow for a single synchronous request/response, and a
// blocking wait past ~30s here is what caused paid calls to come back with
// no response at all. Payment is still gated on this call (via the
// paymentMiddleware above); the paid response is now a jobId to poll instead
// of the final report, so the caller always gets *something* back fast.
function startAnalysisJob(req, res) {
  const { url, format } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body" });

  const jobId = createJob({ format });
  runJobInBackground(jobId, () => runPipeline(url));

  res.status(202).json({
    jobId,
    status: "processing",
    pollUrl: `/jobs/${jobId}`,
    message: "Analysis started. Poll pollUrl for the result (typically 30-90s)."
  });
}

app.post("/analyze_repo", startAnalysisJob);

// Same handler — pipeline.js auto-detects re-run via stored memory. Exposed
// as a separate priced route per the build plan (cheaper: agents may be
// skipped via the diff layer).
app.post("/reanalyze_repo", startAnalysisJob);

// Polling endpoint — not payment-gated (payment already happened on the
// analyze_repo/reanalyze_repo call that created this job).
app.get("/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Unknown jobId" });

  if (job.status === "processing") {
    return res.json({ jobId: job.id, status: "processing" });
  }
  if (job.status === "failed") {
    return res.status(200).json({ jobId: job.id, status: "failed", error: job.error });
  }

  // done
  if (job.format === "markdown") {
    return res.type("text/markdown").send(toMarkdown(job.result));
  }
  return res.json({ jobId: job.id, status: "done", result: job.result });
});

// Streamable HTTP MCP endpoint — this is what OKX A2MCP registration points
// at as "the endpoint". Stateless: no sessionIdGenerator, so no session
// state is kept between calls, which fits per-call billing (each request is
// fully independent, nothing to resume). A fresh server+transport pair per
// request avoids request-id collisions across concurrent callers.
// Only analyze_repo/reanalyze_repo are paid — check_job_status is how the
// caller retrieves a result they already paid for, so it must stay free
// (otherwise polling for a paid job's result would itself cost another 0.5).
const PAID_TOOLS = new Set(["analyze_repo", "reanalyze_repo"]);

app.post("/mcp", async (req, res, next) => {
  const isPaidToolCall = req.body?.method === "tools/call" && PAID_TOOLS.has(req.body?.params?.name);
  if (isPaidToolCall && mcpPaymentGate) {
    return mcpPaymentGate(req, res, next);
  }
  next();
}, async (req, res) => {
  try {
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    // Ensure the request headers satisfy StreamableHTTPServerTransport's requirement
    req.headers["accept"] = "application/json, text/event-stream";
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support the GET (server->client stream) or DELETE
// (session teardown) parts of the spec — there's no session to stream to or
// tear down. Respond per spec so well-behaved clients don't hang on them.
app.get("/mcp", (req, res, next) => {
  if (mcpPaymentGate) {
    return mcpPaymentGate(req, res, next);
  }
  next();
}, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this MCP server is stateless (no SSE stream)." },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this MCP server is stateless (no session to end)." },
    id: null,
  });
});

app.use(express.static("public"));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[ConClave] listening on http://localhost:${PORT}`);
  console.log(`[ConClave] payment gating: ${resourceServer ? `ON (${NETWORK})` : "OFF"}`);
});