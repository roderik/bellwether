import { spawnSync } from "node:child_process";
import { ghFetch, type ProxyFetch } from "./fetch.js";

function spawnText(cmd: string[]): string | null {
  const [command, ...args] = cmd;
  if (!command) return null;
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Local git state
// ---------------------------------------------------------------------------

export function getRepoRoot(): string | null {
  return spawnText(["git", "rev-parse", "--show-toplevel"]);
}

export interface RepoInfo {
  owner: string;
  repo: string;
}

export function getRepoInfo(): RepoInfo | null {
  const envRepo = process.env.GH_REPO;
  if (envRepo) {
    const match = envRepo.match(/^([^/]+)\/([^/]+)$/);
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
  }

  const remoteUrl = spawnText(["git", "remote", "get-url", "origin"]);
  if (!remoteUrl) return null;

  // SSH, HTTPS, and proxy URL formats
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  const proxyMatch = remoteUrl.match(/\/git\/([^/]+)\/([^/]+)$/);

  const match = sshMatch || httpsMatch || proxyMatch;
  if (match?.[1] && match[2]) {
    return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
  }

  return null;
}

export function getCurrentBranch(): string | null {
  return spawnText(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

export interface PR {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  state: string;
}

export async function findPRForBranch(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<PR | null> {
  const response = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
    token,
    proxyFetch,
  );
  if (!response.ok) throw new Error(`Failed to find PR: ${response.status}`);
  const prs = (await response.json()) as PR[];
  return prs[0] || null;
}

export async function listOpenPRs(
  owner: string,
  repo: string,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<PR[]> {
  const response = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=30`,
    token,
    proxyFetch,
  );
  if (!response.ok) throw new Error(`Failed to list PRs: ${response.status}`);
  return (await response.json()) as PR[];
}
