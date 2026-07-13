export function isRateLimit(err) {
  return err?.status === 429;
}

/**
 * Figures out how long to wait before retrying a rate-limited call. Groq
 * exposes exact reset times in response headers; Gemini's ApiError doesn't
 * (just { status, message }), so we fall back to a capped exponential
 * backoff keyed off attempt number when no header/message hint is present.
 */
export function rateLimitWaitMs(err, attempt, capMs = 20_000) {
  const headers = err?.headers || {};
  const resetTokens = headers["x-ratelimit-reset-tokens"] || headers["x-ratelimit-reset-requests"];
  const retryAfter = headers["retry-after"];
  const candidates = [resetTokens, retryAfter]
    .filter(Boolean)
    .map((v) => parseFloat(v))
    .filter((n) => !Number.isNaN(n));
  if (candidates.length) return Math.min(Math.max(...candidates) * 1000 + 500, capMs);

  const match = String(err?.error?.error?.message || err?.message || "").match(/retry.{0,10}?([\d.]+)s/i);
  if (match) return Math.min(parseFloat(match[1]) * 1000 + 500, capMs);

  return Math.min(3000 * (attempt + 1), capMs); // capped exponential fallback
}

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Transient DNS/network drops — no status code, just a dead connection attempt. */
export function isNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  return err?.status === undefined && (NETWORK_ERROR_CODES.has(code) || err?.constructor?.name === "APIConnectionError");
}

/** Google's "high demand" 503s are explicitly documented as transient. */
export function isTransientServerError(err) {
  return err?.status === 503;
}

/**
 * Wraps a single Gemini API call with rate-limit and transient-network retry.
 * Does NOT handle tool_use_failed-style formatting errors — Gemini's native
 * function calling doesn't have that failure mode the way Groq's did, so
 * there's nothing provider-specific left to handle in the tool-use loop.
 */
export async function withNetworkRetry(fn, { maxNetworkRetries = 4, maxRateLimitRetries = 3, rateLimitCapMs = 20_000 } = {}) {
  let netAttempts = 0;
  let rateAttempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimit(err) && rateAttempts < maxRateLimitRetries) {
        const wait = rateLimitWaitMs(err, rateAttempts, rateLimitCapMs);
        rateAttempts++;
        console.warn(`[gemini] rate limited, waiting ${wait}ms (attempt ${rateAttempts}/${maxRateLimitRetries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if ((isNetworkError(err) || isTransientServerError(err)) && netAttempts < maxNetworkRetries) {
        netAttempts++;
        const wait = 1000 * netAttempts;
        console.warn(`[gemini] ${isTransientServerError(err) ? "high demand (503)" : `network error (${err?.cause?.code || err?.code})`}, retrying in ${wait}ms (attempt ${netAttempts}/${maxNetworkRetries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}