import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ghFetch, type ProxyFetch } from "./fetch.js";

// ---------------------------------------------------------------------------
// PR base info
// ---------------------------------------------------------------------------

export interface PRBaseInfo {
  base: string;
  baseSha: string;
}

interface RawPRData {
  base: { ref: string; sha: string };
}

export async function fetchPRBase(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<PRBaseInfo> {
  const response = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    proxyFetch,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch PR base: ${response.status}`);
  }
  const pr = (await response.json()) as RawPRData;
  return { base: pr.base.ref, baseSha: pr.base.sha };
}

// ---------------------------------------------------------------------------
// Git sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  success: boolean;
  hasConflicts: boolean;
  output: string;
}

function spawn(cmd: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const [command, ...args] = cmd;
  if (!command) { return { status: 1, stdout: "", stderr: "empty command" }; }
  const result = spawnSync(command, args, { encoding: "utf-8", cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function syncBranchWithBase(
  base: string,
  strategy: "rebase" | "merge",
  cwd?: string,
): SyncResult {
  const fetch = spawn(["git", "fetch", "origin", base], cwd);
  if (fetch.status !== 0) {
    return { success: false, hasConflicts: false, output: `fetch failed: ${fetch.stderr.trim()}` };
  }

  const ref = `origin/${base}`;
  const op =
    strategy === "rebase"
      ? spawn(["git", "rebase", ref], cwd)
      : spawn(["git", "merge", ref, "--no-edit"], cwd);

  if (op.status === 0) {
    return { success: true, hasConflicts: false, output: op.stdout.trim() };
  }

  // Check if this is a conflict or another error
  const conflictCheck = spawn(["git", "diff", "--name-only", "--diff-filter=U"], cwd);
  const hasConflicts = conflictCheck.stdout.trim().length > 0;

  return {
    success: false,
    hasConflicts,
    output: (op.stdout + op.stderr).trim(),
  };
}

// ---------------------------------------------------------------------------
// Conflict parsing — token-efficient format
// ---------------------------------------------------------------------------

export interface ConflictHunk {
  ours: string[];
  theirs: string[];
}

export interface FileConflicts {
  file: string;
  hunks: ConflictHunk[];
}

export interface ConflictReport {
  count: number;
  files: string[];
  details: Record<string, string[]>;
}

const MAX_LINES_PER_SIDE = 5;
const MAX_LINE_LEN = 120;

function truncate(line: string): string {
  return line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + "…" : line;
}

function parseFileConflicts(content: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }
    if (line.startsWith("<<<<<<<")) {
      const ours: string[] = [];
      const theirs: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("=======") && !lines[i]!.startsWith(">>>>>>>")) {
        ours.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.startsWith("=======")) { i++; }
      while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) {
        theirs.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.startsWith(">>>>>>>")) { i++; }
      hunks.push({ ours, theirs });
    } else {
      i++;
    }
  }

  return hunks;
}

function formatHunk(hunk: ConflictHunk, index: number): string {
  const oursLines = hunk.ours
    .filter((l) => l.trim())
    .slice(0, MAX_LINES_PER_SIDE)
    .map(truncate);
  const theirsLines = hunk.theirs
    .filter((l) => l.trim())
    .slice(0, MAX_LINES_PER_SIDE)
    .map(truncate);

  const oursSuffix = hunk.ours.filter((l) => l.trim()).length > MAX_LINES_PER_SIDE ? " (+more)" : "";
  const theirsSuffix =
    hunk.theirs.filter((l) => l.trim()).length > MAX_LINES_PER_SIDE ? " (+more)" : "";

  return [
    `hunk${index + 1}:`,
    `  ours: ${oursLines.join(" | ")}${oursSuffix}`,
    `  theirs: ${theirsLines.join(" | ")}${theirsSuffix}`,
  ].join(" ");
}

export function parseConflicts(cwd?: string): ConflictReport {
  const result = spawn(["git", "diff", "--name-only", "--diff-filter=U"], cwd);
  const files = result.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const details: Record<string, string[]> = {};

  for (const file of files) {
    try {
      const content = readFileSync(cwd ? `${cwd}/${file}` : file, "utf-8");
      const hunks = parseFileConflicts(content);
      details[file] = hunks.map((h, i) => formatHunk(h, i));
    } catch {
      details[file] = ["(could not read file)"];
    }
  }

  return { count: files.length, files, details };
}
