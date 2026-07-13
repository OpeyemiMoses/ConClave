import { GoogleGenAI } from "@google/genai";
import { buildTools, toolDeclarations } from "./tools.js";
import { withNetworkRetry } from "./retry.js";

const ai = new GoogleGenAI({}); // reads GEMINI_API_KEY from env automatically
// gemini-3.1-flash-lite: GA (stable) high-volume workhorse tier — 20 RPD on
// gemini-3.5-flash's free tier is a taster quota, not something to build a
// 4-agent pipeline on. Flash-Lite trades some reasoning depth for ~1,000+
// RPD and 30 RPM, which fits this workload (repo exploration + report
// writing) far better. Override via GEMINI_MODEL if needed.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const MAX_TURNS = 16;

/**
 * Runs a single Gemini agent through a tool-use loop against a repo on disk.
 * Same external shape as the old Groq version ({ repoDir, systemPrompt, task }
 * -> { report, toolCallLog }) — pipeline.js didn't need to change.
 */
export async function runAgent({ repoDir, systemPrompt, task }) {
  const tools = buildTools(repoDir);
  const contents = [{ role: "user", parts: [{ text: task }] }];
  const toolCallLog = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await withNetworkRetry(() =>
        ai.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction: systemPrompt,
            tools: [{ functionDeclarations: toolDeclarations }],
            temperature: 0,
          },
        })
      );

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        return { report: response.text || "", toolCallLog };
      }

      // Push the model's turn back verbatim (preserves any internal fields
      // like thoughtSignature that newer Gemini models attach) rather than
      // reconstructing it by hand.
      contents.push(response.candidates[0].content);

      const responseParts = [];
      for (const call of functionCalls) {
        let result;
        try {
          result = await tools[call.name](call.args || {});
        } catch (err) {
          result = `ERROR: ${err.message}`;
        }
        toolCallLog.push({ turn, name: call.name, input: call.args });
        responseParts.push({
          functionResponse: {
            id: call.id, // Gemini 3.x requires id matching when a turn has multiple calls; harmless if undefined
            name: call.name,
            response: { output: String(result).slice(0, 4_000) },
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
    }

    return { report: "(hit MAX_TURNS without a final answer)", toolCallLog };
  } catch (err) {
    // Even after retries, this agent couldn't complete — degrade gracefully
    // rather than taking down the whole 4-agent run.
    return {
      report: `(this agent failed after retries: ${err.message || err})`,
      toolCallLog,
    };
  }
}