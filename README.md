# ConClave

Multi-agent GitHub repo analysis ASP — OKX AI Genesis Hackathon.

4 specialist Gemini agents (architecture, security, dependencies, onboarding) explore a repo in
parallel with `read_file`/`list_dir`/`grep` tools, a synthesis agent resolves contradictions
between them, and a diff-aware memory layer means re-runs only re-check what actually changed —
and the synthesis explicitly states which prior conclusions are now invalid.

## Setup

```bash
cp .env.example .env   # fill in GEMINI_API_KEY at minimum
npm install
```

## Test everything in one go (no server, no payment needed)

```bash
npm run test:pipeline -- https://github.com/some-org/some-repo
```

Runs `analyze` then immediately `reanalyze` on the same repo/commit, so you see the full loop:
4 parallel specialists → synthesis → memory save → cache-hit on re-run. Defaults to
`sindresorhus/is-online` (tiny, fast) if no URL given.

To see the diff-aware re-run path do real work (not just cache hit), point it at a repo you
control and push a commit between two manual runs — or run once, then run again after upstream
gets a new commit.

## Run as a server (the actual ASP surface)

```bash
npm start
```

- `POST /analyze_repo {url}` — full first-run analysis
- `POST /reanalyze_repo {url}` — diff-aware re-run (pipeline auto-detects which mode to use
  from stored memory regardless of which route you hit — the two routes exist so they can carry
  different x402 prices)
- `GET /health`
- Add `"format": "markdown"` to the request body for a rendered report instead of JSON
- `public/index.html` — served at `/`, a minimal page to test both endpoints from a browser

**Without** `OKX_API_KEY` + `PAY_TO_ADDRESS` in `.env`, the server runs unpaid (fine for local
testing, logs a warning). **With** them set, `POST /analyze_repo` and `POST /reanalyze_repo` are
gated by OKX's x402 payment middleware — unpaid requests get a 402 and never reach your logic.
Defaults to X Layer **testnet** (`eip155:1952`); flip `X402_NETWORK` to `eip155:196` for mainnet
once you've verified a paid call end-to-end. Get testnet funds (gas + USD₮0) from the
[X Layer Faucet](https://www.okx.com/xlayer/faucet/xlayerfaucet).

## MCP: Streamable HTTP (this is what OKX registration points at)

`npm start` also mounts a real MCP server at `POST /mcp` using the SDK's
`StreamableHTTPServerTransport`, **stateless mode** (no `sessionIdGenerator` — each call is
fully independent, which fits per-call billing: nothing to resume, nothing to garbage collect).
Same `analyze_repo`/`reanalyze_repo` tools as before, just over the wire instead of stdio.

- `POST /mcp` — JSON-RPC 2.0, standard MCP methods (`initialize`, `tools/list`, `tools/call`)
- `GET /mcp` / `DELETE /mcp` — `405`, by design (stateless mode has no SSE stream to open and no
  session to tear down)
- Gated by the same x402 middleware as the REST routes, single flat price per call — matches the
  A2MCP registration form, which asks for one price per call, not per-tool

There's also a stdio variant for quick local MCP-client testing without spinning up the HTTP
server:

```bash
npm run mcp:stdio
```

Point Claude Desktop or the MCP Inspector at it (`node src/mcp-stdio.js` as the command) for a
tool-level sanity check outside the HTTP/payment path.

## Testing, step by step

**1. Pipeline only (no server, no payment) — do this first**

```bash
cp .env.example .env   # fill in GEMINI_API_KEY
npm install
npm run test:pipeline -- https://github.com/some-repo-you-care-about
```

Runs analyze then reanalyze back-to-back. Confirms: ingestion, all 4 specialists in parallel,
synthesis, memory save, and a cache-hit on the second call. This is your one command that proves
the whole brain works, with nothing else in the way.

**2. REST server**

```bash
npm start
```

Leave `OKX_API_KEY`/`PAY_TO_ADDRESS` unset in `.env` for this step — the server logs a warning
and runs unpaid, which is what you want for local testing.

```bash
curl -s http://localhost:4000/health

curl -s -X POST http://localhost:4000/analyze_repo \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/some-repo","format":"markdown"}'
```

Or open `http://localhost:4000` in a browser and use the form.

**3. MCP over Streamable HTTP** (server still running from step 2)

```bash
# initialize
curl -s -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}'

# list tools
curl -s -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# call analyze_repo
curl -s -X POST http://localhost:4000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"analyze_repo","arguments":{"url":"https://github.com/some-repo"}}}'
```

`initialize` and `tools/list` should return instantly. `tools/call` will take as long as the full
pipeline (30-90s). If you get a `405` trying `GET /mcp` — that's correct, not a bug (see above).

**4. Payment gating** (once steps 1-3 pass unpaid)

Fill in `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `PAY_TO_ADDRESS` in `.env`, restart
`npm start`, confirm the log says `payment gating: ON (eip155:1952)`. Hit any of the three routes
without a payment signature — expect `402`. Use an Agentic Wallet with testnet funds from the
[X Layer Faucet](https://www.okx.com/xlayer/faucet/xlayerfaucet) to complete a real paid call and
confirm you get a `200` back with a `PAYMENT-RESPONSE` settlement header. Only flip
`X402_NETWORK` to `eip155:196` (mainnet) after this passes.

**5. Register on OKX.AI** — see the section above. Point the endpoint field at your deployed
`/mcp` route.

Per the OKX docs, ASP registration goes through Onchain OS in your agent, not a code call:

```
Install Onchain OS via npx skills add okx/onchainos-skills --yes -g, then log in to Agentic Wallet with my email
```

Then:

```
Help me register an A2MCP ASP on OKX.AI using Onchain OS
```

You'll be asked for name, description, price per call, and your public endpoint (this server,
deployed). Listing review takes up to 2 business days.

## Architecture

```
src/ingest.js       shallow clone (fast, first run) / full clone (needed to diff, re-runs)
src/tools.js         read_file / list_dir / grep — sandboxed to repoDir, path-escape blocked
src/gemini-agent.js    tool-use loop (Gemini, native function calling, gemini-2.5-flash by default)
src/specialists.js   4 narrow system prompts — architecture / security / dependencies / onboarding
src/synthesis.js      contradiction-resolution + unified report, aware of prior synthesis on re-run
src/memory.js         JSON-file store keyed by repo URL + diff-to-agent relevance heuristics
src/pipeline.js       orchestrates the above, auto-detects first-run vs re-run
src/retry.js           shared rate-limit + transient-network retry, used by gemini-agent.js and synthesis.js
src/report.js         structured result -> shareable Markdown
src/server.js         Express + OKX x402 payment middleware + Streamable HTTP MCP at POST /mcp
src/mcp.js             shared MCP tool definitions (analyze_repo / reanalyze_repo)
src/mcp-stdio.js       stdio entrypoint using src/mcp.js — local MCP-client testing only
public/index.html     minimal browser UI to hit the REST API
```

## What's validated vs. what needs your keys

Validated in this build environment (no real LLM/payment keys required):
- Real repo clone (shallow + full), commit SHA capture, manifest detection
- `read_file`/`list_dir`/`grep` against a real repo, including path-escape blocking
- `git diff --name-only` between two real commits
- Diff → agent relevance classification (all 5 cases checked)
- Memory save/load roundtrip
- Server boots, `/health` responds, payment gating correctly toggles off without OKX keys and
  warns about it
- Full MCP JSON-RPC handshake over Streamable HTTP: `initialize` and `tools/list` both return
  correct results; `tools/call` was confirmed to route all the way into the pipeline (it stopped
  at the network egress boundary of this sandbox, which doesn't allow `generativelanguage.googleapis.com`
  — on your machine this reaches Gemini)
- `GET /mcp` and `DELETE /mcp` correctly return `405` (stateless mode, by design)

**Not yet run for real** (needs `GEMINI_API_KEY` + network access to Google's API): the actual
4-specialist-parallel + synthesis LLM calls. Run `npm run test:pipeline` first thing on your
machine — that's your single "does it all work end to end" smoke test.
