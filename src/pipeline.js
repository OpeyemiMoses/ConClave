import { ingestRepo, diffCommits, normalizeRepoUrl } from "./ingest.js";
import { runAgent } from "./gemini-agent.js";
import { SPECIALISTS, SPECIALIST_KEYS } from "./specialists.js";
import { synthesize } from "./synthesis.js";
import { getMemory, saveMemory, classifyDiff } from "./memory.js";

/** A cached report is only trustworthy if the agent actually succeeded. */
function isFailedReport(text) {
  return typeof text === "string" && (text.startsWith("(this agent failed") || text.startsWith("(hit MAX_TURNS"));
}

function failedKeys(specialists) {
  return Object.entries(specialists)
    .filter(([, text]) => isFailedReport(text))
    .map(([key]) => key);
}

/**
 * Runs the full ConClave pipeline against a repo. Auto-detects first-run vs
 * re-run based on stored memory for this repo URL.
 *
 * @param {string} repoUrl
 * @returns {Promise<object>} structured result — see report.js for rendering
 */
export async function runPipeline(repoUrl) {
  repoUrl = normalizeRepoUrl(repoUrl);
  const prior = await getMemory(repoUrl);
  return prior ? reanalyze(repoUrl, prior) : analyze(repoUrl);
}

const SPECIALIST_BATCH_SIZE = 2;
const BATCH_GAP_MS = 3000;

async function runSpecialists(repoDir, keys) {
  const results = {};
  for (let i = 0; i < keys.length; i += SPECIALIST_BATCH_SIZE) {
    const batch = keys.slice(i, i + SPECIALIST_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (key) => {
        const spec = SPECIALISTS[key];
        const { report } = await runAgent({
          repoDir,
          systemPrompt: spec.systemPrompt,
          task: spec.task,
        });
        return [key, report];
      })
    );
    for (const [key, report] of batchResults) results[key] = report;

    const isLastBatch = i + SPECIALIST_BATCH_SIZE >= keys.length;
    if (!isLastBatch) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
  }
  return results;
}

/** Synthesis failing shouldn't throw away 4 successful specialist reports. */
async function synthesizeSafe(args) {
  try {
    return await synthesize(args);
  } catch (err) {
    return `(synthesis failed after retries: ${err.message || err} — see individual specialist reports below)`;
  }
}

async function analyze(repoUrl) {
  const { repoDir, sha, cleanup } = await ingestRepo(repoUrl, { shallow: true });
  try {
    const specialists = await runSpecialists(repoDir, SPECIALIST_KEYS);
    const synthesis = await synthesizeSafe({ reports: specialists });

    const result = {
      repo: repoUrl,
      sha,
      timestamp: new Date().toISOString(),
      specialists,
      synthesis,
      diff: null,
    };

    await saveMemory(repoUrl, { sha, specialists, synthesis });
    return result;
  } finally {
    await cleanup();
  }
}

async function reanalyze(repoUrl, prior) {
  // Need full history this time so we can diff prior.sha -> newSha.
  const { repoDir, sha, cleanup } = await ingestRepo(repoUrl, { shallow: false });
  try {
    const priorFailures = failedKeys(prior.specialists);

    if (sha === prior.sha) {
      // Nothing changed in the repo. Still worth retrying any specialist that
      // failed last time (rate limit, malformed tool call, etc) — a failure
      // isn't a valid finding and shouldn't be cached as one forever.
      if (!priorFailures.length) {
        return {
          repo: repoUrl,
          sha,
          timestamp: new Date().toISOString(),
          specialists: prior.specialists,
          synthesis: prior.synthesis,
          diff: { prevSha: prior.sha, changedFiles: [], rerun: [], reused: SPECIALIST_KEYS },
        };
      }

      const retried = await runSpecialists(repoDir, priorFailures);
      const specialists = { ...prior.specialists, ...retried };
      const synthesis = await synthesizeSafe({ reports: specialists });
      const result = {
        repo: repoUrl,
        sha,
        timestamp: new Date().toISOString(),
        specialists,
        synthesis,
        diff: {
          prevSha: prior.sha,
          changedFiles: [],
          rerun: priorFailures,
          reused: SPECIALIST_KEYS.filter((k) => !priorFailures.includes(k)),
        },
      };
      await saveMemory(repoUrl, { sha, specialists, synthesis });
      return result;
    }

    const changedFiles = await diffCommits(repoDir, prior.sha, sha);
    // null means the diff couldn't be computed (e.g. history rewritten) —
    // safest fallback is to treat it as a full re-run.
    const { toRerun: diffRerun, toReuse } =
      changedFiles === null
        ? { toRerun: SPECIALIST_KEYS, toReuse: [] }
        : classifyDiff(changedFiles);

    // Union with anything that failed last time, regardless of whether the
    // diff heuristic flagged its area — a stale failure should never just
    // ride along as "reused".
    const toRerun = [...new Set([...diffRerun, ...priorFailures])];

    const freshReports = toRerun.length ? await runSpecialists(repoDir, toRerun) : {};
    const specialists = { ...prior.specialists, ...freshReports };

    const synthesis = await synthesizeSafe({
      reports: specialists,
      priorSynthesis: prior.synthesis,
      changedFiles: changedFiles || ["(unable to compute diff — treated as full re-run)"],
    });

    const result = {
      repo: repoUrl,
      sha,
      timestamp: new Date().toISOString(),
      specialists,
      synthesis,
      diff: {
        prevSha: prior.sha,
        changedFiles: changedFiles || [],
        rerun: toRerun,
        reused: toReuse.filter((k) => !priorFailures.includes(k)),
      },
    };

    await saveMemory(repoUrl, { sha, specialists, synthesis });
    return result;
  } finally {
    await cleanup();
  }
}
