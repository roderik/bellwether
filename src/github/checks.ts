import { ghFetch, type ProxyFetch } from "./fetch.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  app: { name: string; slug: string } | null;
}

export interface CIStatus {
  sha: string;
  total: number;
  completed: number;
  pending: number;
  passing: number;
  failing: number;
  checks: CheckRun[];
}

// ---------------------------------------------------------------------------
// Fetch CI status
// ---------------------------------------------------------------------------

export async function fetchCIStatus(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  proxyFetch: ProxyFetch
): Promise<CIStatus> {
  // Get PR head SHA
  const prResponse = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    proxyFetch
  );
  if (!prResponse.ok) {
    throw new Error(`Failed to fetch PR: ${prResponse.status}`);
  }
  const pr = (await prResponse.json()) as any;
  const sha = pr.head.sha as string;

  // Fetch check runs for that SHA
  const checksResponse = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    token,
    proxyFetch
  );
  if (!checksResponse.ok) {
    throw new Error(`Failed to fetch checks: ${checksResponse.status}`);
  }
  const checksData = (await checksResponse.json()) as any;
  const checks: CheckRun[] = checksData.check_runs;

  const completed = checks.filter((c) => c.status === "completed").length;
  const pending = checks.filter((c) => c.status !== "completed").length;
  const passing = checks.filter(
    (c) =>
      c.conclusion === "success" ||
      c.conclusion === "skipped" ||
      c.conclusion === "neutral"
  ).length;
  const failing = checks.filter(
    (c) =>
      c.conclusion === "failure" ||
      c.conclusion === "timed_out" ||
      c.conclusion === "action_required"
  ).length;

  return {
    sha,
    total: checks.length,
    completed,
    pending,
    passing,
    failing,
    checks,
  };
}
