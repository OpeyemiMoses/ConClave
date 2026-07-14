import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@okxweb3/x402-core/client";
import { registerExactEvmScheme } from "@okxweb3/x402-evm/exact/client";
import { wrapFetchWithPayment } from "@okxweb3/x402-fetch";

// Standalone script to exercise the FULL paid flow end-to-end: sends a
// request, receives the 402, signs a real payment, retries, and prints the
// settlement confirmation. This is what actually proves your x402 server
// wiring works — a plain curl/Invoke-RestMethod can only ever see the 402,
// it can't complete the payment.
//
// SAFETY: TEST_WALLET_PRIVATE_KEY should be a throwaway key funded ONLY via
// the X Layer testnet faucet. Never put a real/mainnet key in this file or
// in .env. Get testnet funds: https://www.okx.com/xlayer/faucet/xlayerfaucet

const PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
const SERVER_URL = process.env.CONCLAVE_URL || "http://localhost:4000";
const REPO_URL = process.argv[2] || "https://github.com/OpeyemiMoses/STRATEX";

if (!PRIVATE_KEY) {
  console.error("Set TEST_WALLET_PRIVATE_KEY in .env — a throwaway key funded via the X Layer testnet faucet.");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Paying from: ${account.address}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const fetchWithPay = wrapFetchWithPayment(fetch, client);

async function main() {
  console.log(`Requesting POST ${SERVER_URL}/analyze_repo for ${REPO_URL} (will auto-pay on 402)...`);
  const res = await fetchWithPay(`${SERVER_URL}/analyze_repo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: REPO_URL, format: "markdown" }),
  });

  console.log(`Final status: ${res.status}`);
  const paymentResponseHeader = res.headers.get("payment-response") || res.headers.get("x-payment-response");
  if (paymentResponseHeader) {
    console.log("Settlement confirmation header present:", paymentResponseHeader);
  } else {
    console.log("No settlement header found — check response headers manually if this seems wrong.");
  }

  const text = await res.text();
  const outPath = new URL("../last-report.md", import.meta.url);
  await writeFile(outPath, text);
  console.log(`\nFull response (${text.length} chars) written to: ${outPath.pathname}`);
  console.log("\n--- Preview (first 500 chars) ---\n");
  console.log(text.slice(0, 500) + (text.length > 500 ? "\n...(see file for the rest)" : ""));
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});