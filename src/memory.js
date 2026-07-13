import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "memory.json");

function slugify(repoUrl) {
  return repoUrl.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-");
}

async function loadDb() {
  try {
    const raw = await readFile(DB_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveDb(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

export async function getMemory(repoUrl) {
  const db = await loadDb();
  return db[slugify(repoUrl)] || null;
}

export async function saveMemory(repoUrl, record) {
  const db = await loadDb();
  db[slugify(repoUrl)] = { ...record, updatedAt: new Date().toISOString() };
  await saveDb(db);
}

// Heuristic map: which changed-file patterns make each specialist's findings
// potentially stale. Used by the diff layer to decide which agents to re-run
// vs. reuse cached findings for.
const RELEVANCE_PATTERNS = {
  dependencies: [
    /package(-lock)?\.json$/,
    /requirements.*\.txt$/,
    /pyproject\.toml$/,
    /Pipfile(\.lock)?$/,
    /go\.(mod|sum)$/,
    /Cargo\.(toml|lock)$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
  ],
  security: [
    /auth/i,
    /security/i,
    /secret/i,
    /\.env/i,
    /middleware/i,
    /config/i,
    /crypto/i,
    /session/i,
  ],
  onboarding: [
    /^README/i,
    /^CONTRIBUTING/i,
    /^docs\//i,
    /package\.json$/,
    /Makefile$/,
  ],
  // architecture is intentionally broad: any source file change is
  // potentially architecturally relevant, so it's excluded from this map
  // and handled as "always re-run if anything changed" in the caller.
};

/**
 * @param {string[]} changedFiles - relative paths from `git diff --name-only`
 * @returns {{ toRerun: string[], toReuse: string[] }}
 */
export function classifyDiff(changedFiles) {
  if (!changedFiles.length) return { toRerun: [], toReuse: ["architecture", "security", "dependencies", "onboarding"] };

  const toRerun = new Set(["architecture"]); // always re-check structure if anything changed
  for (const file of changedFiles) {
    for (const [agent, patterns] of Object.entries(RELEVANCE_PATTERNS)) {
      if (patterns.some((re) => re.test(file))) toRerun.add(agent);
    }
  }
  const all = ["architecture", "security", "dependencies", "onboarding"];
  const toReuse = all.filter((a) => !toRerun.has(a));
  return { toRerun: [...toRerun], toReuse };
}
