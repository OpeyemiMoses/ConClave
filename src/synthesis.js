import { GoogleGenAI } from "@google/genai";
import { withNetworkRetry } from "./retry.js";

const ai = new GoogleGenAI({});
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

const SYNTHESIS_SYSTEM = `You are a synthesis agent. You receive independent reports from 4 specialist
agents (architecture, security, dependencies, onboarding) who each explored the same repo without
seeing each other's findings. Your job:

1. Find contradictions or tension between their findings (e.g. architecture calls something a strength
   that security flags as a risk) and resolve them explicitly.
2. Produce ONE unified report a human would actually read — not four sections stapled together.
3. If given a prior synthesis + a diff summary (re-run mode), explicitly call out which prior
   conclusions are now invalid and why, before presenting current findings.

Be direct and concise. This is a review artifact, not marketing copy.`;

/**
 * @param {object} opts
 * @param {Record<string,string>} opts.reports - { architecture, security, dependencies, onboarding }
 * @param {string} [opts.priorSynthesis] - previous synthesis text, only on re-run
 * @param {string[]} [opts.changedFiles] - diff file list, only on re-run
 * @returns {Promise<string>}
 */
export async function synthesize({ reports, priorSynthesis, changedFiles }) {
  const sections = Object.entries(reports)
    .map(([key, text]) => `### ${key}\n${text}`)
    .join("\n\n");

  let userContent = `Specialist reports:\n\n${sections}\n\nProduce the unified report.`;

  if (priorSynthesis) {
    userContent =
      `This is a RE-RUN. The repo changed. Changed files:\n${(changedFiles || []).join("\n") || "(unknown)"}\n\n` +
      `Prior synthesis report:\n${priorSynthesis}\n\n` +
      `Current specialist reports (some agents were skipped and their prior findings reused where their ` +
      `area had no relevant changes — treat those sections as still-valid unless the diff suggests otherwise):\n\n${sections}\n\n` +
      `Produce the updated unified report. Start with a short "What changed since last analysis" section ` +
      `naming which prior conclusions are now invalid and why, then the current unified findings.`;
  }

  const response = await withNetworkRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      config: { systemInstruction: SYNTHESIS_SYSTEM },
    })
  );

  return response.text || "";
}