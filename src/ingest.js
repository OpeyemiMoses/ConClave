import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_CLONE_RETRIES = 3;

async function cloneWithRetry(cloneArgs) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_CLONE_RETRIES; attempt++) {
    try {
      return await execFileAsync("git", cloneArgs, { maxBuffer: 1024 * 1024 * 50 });
    } catch (err) {
      lastErr = err;
      // Transient network drops ("Recv failure: Connection was reset", "early EOF",
      // "unexpected disconnect") are common on full (non-shallow) clones over a
      // flaky connection — worth a few retries before giving up.
      const transient = /Recv failure|early EOF|unexpected disconnect|Connection reset|Connection timed out/i.test(
        String(err?.stderr || err?.message || "")
      );
      if (!transient || attempt === MAX_CLONE_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Fixes common URL mistakes: doubled scheme, missing scheme, trailing slash. */
export function normalizeRepoUrl(repoUrl) {
  let url = repoUrl.trim().replace(/\/+$/, "");
  // collapse "https://https://..." or "http://https://..." etc.
  url = url.replace(/^(https?:\/\/)+(?=https?:\/\/)/i, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

/**
 * Clones a GitHub repo into a temp dir and captures the commit SHA. This SHA
 * is the "memory key" referenced in the build plan's diff layer.
 *
 * @param {string} repoUrl - e.g. https://github.com/owner/repo
 * @param {object} [opts]
 * @param {boolean} [opts.shallow=true] - shallow (depth 1) is fast but has no
 *   history, so it can't be diffed against an older SHA. Pass shallow:false
 *   for re-analyze runs where we need `git diff oldSha..newSha`.
 * @returns {Promise<{repoDir: string, sha: string, manifestFiles: string[], cleanup: () => Promise<void>}>}
 */
export async function ingestRepo(repoUrl, opts = {}) {
  const { shallow = true } = opts;
  repoUrl = normalizeRepoUrl(repoUrl);
  const workDir = await mkdtemp(path.join(tmpdir(), "conclave-"));
  const repoDir = path.join(workDir, "repo");

  const cloneArgs = shallow
    ? ["clone", "--depth", "1", repoUrl, repoDir]
    : ["clone", repoUrl, repoDir];
  await cloneWithRetry(cloneArgs);

  const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
  });
  const sha = shaOut.trim();

  const topLevel = await readdir(repoDir);
  const manifestCandidates = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "README.md",
    "readme.md",
    "README",
  ];
  const manifestFiles = topLevel.filter((f) => manifestCandidates.includes(f));

  return {
    repoDir,
    sha,
    manifestFiles,
    cleanup: async () => rm(workDir, { recursive: true, force: true }),
  };
}

/**
 * Returns the list of changed file paths between two commits in a repo that
 * was cloned with `shallow: false`. If oldSha isn't reachable in history
 * (e.g. it was itself a shallow clone's HEAD, or force-pushed away), falls
 * back to treating everything as changed.
 *
 * @param {string} repoDir
 * @param {string} oldSha
 * @param {string} newSha
 * @returns {Promise<string[]>}
 */
export async function diffCommits(repoDir, oldSha, newSha) {
  if (oldSha === newSha) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", oldSha, newSha],
      { cwd: repoDir, maxBuffer: 1024 * 1024 * 20 }
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    return null; // signals "couldn't diff, caller should treat as full re-run"
  }
}
