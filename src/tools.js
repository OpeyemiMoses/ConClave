import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 8_000; // truncate large files so we don't blow the context window
const MAX_GREP_MATCHES = 100;

/** Resolves a repo-relative path and guarantees it can't escape repoDir. */
function safeResolve(repoDir, relPath) {
  const resolved = path.resolve(repoDir, relPath || ".");
  if (!resolved.startsWith(path.resolve(repoDir))) {
    throw new Error(`Path escapes repo root: ${relPath}`);
  }
  return resolved;
}

export function buildTools(repoDir) {
  return {
    async read_file({ path: relPath }) {
      const abs = safeResolve(repoDir, relPath);
      const s = await stat(abs);
      if (s.isDirectory()) throw new Error(`${relPath} is a directory, use list_dir`);
      const buf = await readFile(abs);
      const text = buf.toString("utf-8");
      if (text.length > MAX_FILE_BYTES) {
        return text.slice(0, MAX_FILE_BYTES) + `\n\n...[truncated, ${text.length} bytes total]`;
      }
      return text;
    },

    async list_dir({ path: relPath }) {
      const abs = safeResolve(repoDir, relPath || ".");
      const entries = await readdir(abs, { withFileTypes: true });
      return entries
        .filter((e) => e.name !== ".git")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    },

    async grep({ pattern, path: relPath }) {
      if (pattern && pattern.length > 150) {
        throw new Error(
          `Pattern too long (${pattern.length} chars). Use a short, specific pattern (under 150 chars) ` +
            `and run grep multiple times for different terms instead of one giant alternation.`
        );
      }
      const abs = safeResolve(repoDir, relPath || ".");
      try {
        const { stdout } = await execFileAsync(
          "grep",
          ["-rniE", "--exclude-dir=.git", "-m", "3", pattern, abs],
          { maxBuffer: 1024 * 1024 * 10 }
        );
        const lines = stdout.split("\n").filter(Boolean).slice(0, MAX_GREP_MATCHES);
        return lines
          .map((l) => l.replace(abs + path.sep, "").replace(abs, "."))
          .join("\n") || "(no matches)";
      } catch (err) {
        if (err.code === 1) return "(no matches)"; // grep exit code 1 = no matches
        throw err;
      }
    },
  };
}

// Gemini's FunctionDeclaration format — plain JSON Schema (lowercase types),
// no wrapper object like OpenAI/Groq's { type: "function", function: {...} }.
export const toolDeclarations = [
  {
    name: "read_file",
    description: "Read the full contents of a file, given a path relative to the repo root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative file path" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List files and subdirectories at a given path relative to the repo root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative dir path, '.' for root" } },
      required: [],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex pattern, recursively from a given path.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regex pattern to search for" },
        path: { type: "string", description: "Repo-relative dir path to search within, default root" },
      },
      required: ["pattern"],
    },
  },
];
