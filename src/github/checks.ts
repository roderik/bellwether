import { ghFetch, type ProxyFetch } from "./fetch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailingCheck {
  name: string;
  conclusion: string;
  html_url: string;
  log: string;
}

export interface CIStatus {
  sha: string;
  total: number;
  passing: number;
  failing: number;
  pending: number;
  passed: string[];
  in_progress: string[];
  failures: FailingCheck[];
}

// ---------------------------------------------------------------------------
// Job log fetching + RTK-style filtering
// ---------------------------------------------------------------------------

const MAX_LINES = 60;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/;
const GROUP_MARKERS = /^##\[(group|endgroup|command|section)\]/;
const NOISE_RE =
  /^(##\[debug\]|##\[notice\]|##\[save-state\]|##\[add-matcher\]|##\[remove-matcher\]|##\[set-output\]|##\[set-env\]|##\[add-path\]|##\[warning\]Couldn't find any|Downloading |Download action repository|Complete job name:|shell: \/|error: script ".*" exited with code|\$ )/;
// RTK "failure focus": strip passing test/check lines, keep only failures
const PASSING_LINE_RE = /^( *✓ | *✔ | *PASS | *√ | *ok \d| *\. |\s*\d+ passing)/;

function parseJobId(htmlUrl: string): string | null {
  const m = htmlUrl.match(/\/job\/(\d+)/);
  return m?.[1] ?? null;
}

function filterLog(raw: string): string {
  const lines = raw.split("\n");

  // Find the failed step: look for ##[error]Process completed with exit code
  // and walk backwards to find its ##[group] start
  let failStart = -1;
  let failEnd = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (failEnd === -1 && line.includes("##[error]Process completed with exit code")) {
      failEnd = i;
    }
    if (failEnd !== -1 && line.includes("##[group]")) {
      failStart = i;
      break;
    }
  }

  // If we found a failed step, extract just that; otherwise use entire log
  const stepLines = failStart !== -1 && failEnd !== -1 ? lines.slice(failStart, failEnd) : lines;

  const cleaned = stepLines
    .map((l) => l.replace(ANSI_RE, "")) // strip ANSI
    .map((l) => l.replace(TIMESTAMP_RE, "")) // strip timestamps
    .filter((l) => !GROUP_MARKERS.test(l)) // strip ##[group] markers
    .filter((l) => !NOISE_RE.test(l)) // strip debug/notice noise
    .filter((l) => !PASSING_LINE_RE.test(l)) // strip passing test lines (failure focus)
    .map((l) => l.replace(/^##\[error\]/, "")) // strip ##[error] prefix, keep content
    .map((l) => l.replace(/^##\[warning\]/, "")) // strip ##[warning] prefix, keep content
    .filter((l) => l.trim() !== "") // strip blank lines
    .map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l)); // truncate long lines

  // Tail: keep last N lines (error summaries are at the end)
  const tail = cleaned.length > MAX_LINES ? cleaned.slice(-MAX_LINES) : cleaned;

  return tail.join("\n");
}

async function fetchJobLog(
  owner: string,
  repo: string,
  jobId: string,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<string> {
  try {
    const res = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      token,
      proxyFetch,
    );
    if (!res.ok) {
      return `[failed to fetch logs: ${res.status}]`;
    }
    return filterLog(await res.text());
  } catch {
    return "[failed to fetch logs]";
  }
}

// ---------------------------------------------------------------------------
// Fetch CI status
// ---------------------------------------------------------------------------

export async function fetchCIStatus(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  proxyFetch: ProxyFetch,
): Promise<CIStatus> {
  // Get PR head SHA
  const prResponse = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    proxyFetch,
  );
  if (!prResponse.ok) {
    throw new Error(`Failed to fetch PR: ${prResponse.status}`);
  }
  const pr = await prResponse.json();
  const sha = pr.head.sha as string;

  // Fetch check runs for that SHA
  const checksResponse = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    token,
    proxyFetch,
  );
  if (!checksResponse.ok) {
    throw new Error(`Failed to fetch checks: ${checksResponse.status}`);
  }
  const checksData = await checksResponse.json();
  const rawChecks = checksData.check_runs as any[];

  const isPassing = (c: any) =>
    c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral";
  const isFailing = (c: any) =>
    c.conclusion === "failure" ||
    c.conclusion === "timed_out" ||
    c.conclusion === "action_required";

  const passed = rawChecks.filter(isPassing).map((c) => c.name as string);
  const in_progress = rawChecks
    .filter((c) => c.status !== "completed")
    .map((c) => c.name as string);
  const failingChecks = rawChecks.filter(isFailing);

  // Fetch job logs for failing checks in parallel
  const failures: FailingCheck[] = await Promise.all(
    failingChecks.map(async (c) => {
      const jobId = parseJobId(c.html_url);
      const log = jobId
        ? await fetchJobLog(owner, repo, jobId, token, proxyFetch)
        : "[could not parse job ID from URL]";
      return {
        name: c.name as string,
        conclusion: c.conclusion as string,
        html_url: c.html_url as string,
        log,
      };
    }),
  );

  return {
    sha,
    total: rawChecks.length,
    passing: passed.length,
    failing: failingChecks.length,
    pending: in_progress.length,
    passed,
    in_progress,
    failures,
  };
}
