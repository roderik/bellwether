import  { type Context } from "../context.js";
import { fetchCIStatus, type CIStatus } from "../github/index.js";

export function flatten(
  status: CIStatus,
  extra?: Record<string, boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    sha: status.sha,
    checks: `${status.total} total, ${status.passing} passing, ${status.failing} failing, ${status.pending} pending`,
  };
  if (status.passed.length > 0) {
    out.passed = status.passed.join(", ");
  }
  if (status.in_progress.length > 0) {
    out.in_progress = status.in_progress.join(", ");
  }
  for (const f of status.failures) {
    const label =
      f.conclusion === "failure" ? `FAIL ${f.name}` : `${f.conclusion.toUpperCase()} ${f.name}`;
    out[label] = f.log;
  }
  if (extra) {
    Object.assign(out, extra);
  }
  return out;
}

export async function getCISection(
  ctx: Context,
  prNumber: number,
): Promise<{ status: CIStatus; flat: Record<string, string | number | boolean> }> {
  const { token, repoInfo, proxyFetch } = ctx;
  const status = await fetchCIStatus(repoInfo.owner, repoInfo.repo, prNumber, token, proxyFetch);
  return { status, flat: flatten(status) };
}
