import { randomUUID } from "crypto";

/**
 * In-memory async job store. The pipeline (30-90s+, longer under Gemini rate
 * limiting) is too slow for a single synchronous HTTP request/response — the
 * caller pays, gets a jobId back immediately, then polls. Jobs vanish on
 * restart; fine for a hackathon deploy, not a durability guarantee.
 */
const jobs = new Map();

export function createJob({ format } = {}) {
  const id = randomUUID();
  jobs.set(id, { id, status: "processing", createdAt: Date.now(), format: format || "json", result: null, error: null });
  return id;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
}

export function failJob(id, err) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "failed";
  job.error = err?.message || String(err);
  job.finishedAt = Date.now();
}

/** Runs the pipeline in the background and records the outcome on the job. */
export function runJobInBackground(id, pipelineFn) {
  pipelineFn()
    .then((result) => completeJob(id, result))
    .catch((err) => {
      console.error(`[jobs] job ${id} failed:`, err);
      failJob(id, err);
    });
}
