import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { toMarkdown } from "./report.js";

const repoUrl = process.argv[2] || "https://github.com/sindresorhus/is-online";

async function main() {
  console.log(`=== Run 1: analyze (first time — expect all 4 agents to run) ===`);
  console.log(`Repo: ${repoUrl}\n`);
  const t0 = Date.now();
  const result1 = await runPipeline(repoUrl);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(toMarkdown(result1));

  console.log(`\n\n=== Run 2: reanalyze (same repo, same commit — expect cache hit, 0 LLM calls) ===\n`);
  const t1 = Date.now();
  const result2 = await runPipeline(repoUrl);
  console.log(`Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`Changed files: ${result2.diff.changedFiles.length}`);
  console.log(`Re-ran agents: ${result2.diff.rerun.join(", ") || "(none)"}`);
  console.log(`Reused agents: ${result2.diff.reused.join(", ")}`);

  console.log(`\nRun 2 should be dramatically faster than Run 1 with 0 changed files — that's the`);
  console.log(`diff-aware memory layer working. To test an actual diff, run again after the target`);
  console.log(`repo gets a new commit, or point at a repo you control and push a change between runs.`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
