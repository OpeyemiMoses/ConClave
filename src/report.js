import { SPECIALISTS } from "./specialists.js";

/**
 * @param {object} result - shape returned by pipeline.js
 * @returns {string} markdown
 */
export function toMarkdown(result) {
  const { repo, sha, timestamp, specialists, synthesis, diff } = result;

  let md = `# ConClave Report\n\n`;
  md += `**Repo:** ${repo}\n**Commit:** \`${sha}\`\n**Generated:** ${timestamp}\n\n`;

  if (diff) {
    md += `## Re-run summary\n`;
    md += `- Previous commit: \`${diff.prevSha}\`\n`;
    md += `- Changed files: ${diff.changedFiles.length}\n`;
    md += `- Re-ran agents: ${diff.rerun.join(", ") || "(none — no relevant changes)"}\n`;
    md += `- Reused cached findings: ${diff.reused.join(", ") || "(none)"}\n\n`;
  }

  md += `## Unified Findings\n\n${synthesis}\n\n`;
  md += `---\n\n## Specialist Reports\n\n`;
  for (const key of Object.keys(specialists)) {
    md += `### ${SPECIALISTS[key]?.label || key}\n${specialists[key]}\n\n`;
  }

  return md;
}
