import { spawnSync } from "node:child_process";
import { ghFetch, type ProxyFetch } from "./fetch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConflictHunk {
  ours: string;
  theirs: string;
}

export interface FileConflict {
  file: string;
  count: number;
  hunks: ConflictHunk[];
}

export interface UpdateBranchResult {
  updated: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// GitHub API: update PR branch (merge base into PR branch)
// ---------------------------------------------------------------------------

export async function updatePRBranch(
  owner: string,
  repo: string,
  prNumber: number,
  expectedHeadSha: string | undefined,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<UpdateBranchResult> {
  const body: Record<string, string> = {};
  if (expectedHeadSha) {
    body.expected_head_sha = expectedHeadSha;
  }

  const response = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`,
    token,
    proxyFetch,
    {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );

  if (response.status === 202) {
    const data = (await response.json()) as { message: string; url: string };
    return { updated: true, message: data.message };
  }

  if (response.status === 204) {
    return { updated: true, message: "Branch already up to date" };
  }

  if (response.status === 422) {
    const data = (await response.json()) as { message: string };
    return { updated: false, message: data.message };
  }

  throw new Error(`update-branch API returned unexpected status: ${response.status}`);
}

// ---------------------------------------------------------------------------
// Local conflict detection via git merge-tree (no working tree modification)
// ---------------------------------------------------------------------------

export function detectLocalConflicts(
  baseBranch: string,
  repoRoot: string,
  prHeadRef = "HEAD",
  maxHunksPerFile = 3,
): FileConflict[] {
  // Guard against option injection: refs starting with '-' would be
  // interpreted as git options.
  if (baseBranch.startsWith("-") || prHeadRef.startsWith("-")) {
    return [];
  }

  const fetchResult = spawnSync("git", ["fetch", "--quiet", "origin", "--", baseBranch], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (fetchResult.status !== 0) {
    return [];
  }

  // Verify prHeadRef exists locally before attempting merge-base/merge-tree.
  // If the caller passed a remote SHA that hasn't been fetched, the git
  // commands below would silently fail and return no conflict info.
  const refCheck = spawnSync("git", ["cat-file", "-e", `${prHeadRef}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (refCheck.status !== 0) {
    return [];
  }

  const mergeBaseResult = spawnSync(
    "git",
    ["merge-base", "--", prHeadRef, `origin/${baseBranch}`],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    return [];
  }
  const baseCommit = mergeBaseResult.stdout.trim();

  // 3-argument merge-tree simulates the merge without touching the working tree.
  // Exit code is 0 even when conflicts exist.
  const mergeTreeResult = spawnSync(
    "git",
    ["merge-tree", baseCommit, prHeadRef, `origin/${baseBranch}`],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
  );

  if (!mergeTreeResult.stdout) {
    return [];
  }

  return parseMergeTreeOutput(mergeTreeResult.stdout, maxHunksPerFile);
}

// ---------------------------------------------------------------------------
// Parsing helpers (exported for testing)
// ---------------------------------------------------------------------------

export function parseMergeTreeOutput(output: string, maxHunksPerFile: number): FileConflict[] {
  const conflicts: FileConflict[] = [];

  // Each conflicting file block starts with "changed in both\n"
  const sections = output.split(/\nchanged in both\n/);

  for (const section of sections) {
    const ourFileMatch = section.match(/^\s+our\s+\d+\s+\w+\s+(.+)$/m);
    if (!ourFileMatch?.[1]) {
      continue;
    }
    const file = ourFileMatch[1].trim();
    const hunks = extractConflictHunks(section, maxHunksPerFile);
    if (hunks.length > 0) {
      conflicts.push({ file, count: hunks.length, hunks });
    }
  }

  return conflicts;
}

export function extractConflictHunks(text: string, maxHunks: number): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length && hunks.length < maxHunks) {
    const line = lines[i] ?? "";
    if (line.startsWith("<<<<<<<")) {
      const oursLines: string[] = [];
      const theirsLines: string[] = [];
      let inTheirs = false;
      i++;

      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.startsWith(">>>>>>>")) {
          i++;
          break;
        }
        if (l.startsWith("=======")) {
          inTheirs = true;
        } else if (inTheirs) {
          theirsLines.push(l);
        } else {
          oursLines.push(l);
        }
        i++;
      }

      hunks.push({
        ours: oursLines.join("\n"),
        theirs: theirsLines.join("\n"),
      });
    } else {
      i++;
    }
  }

  return hunks;
}
