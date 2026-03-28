import * as clack from "@clack/prompts";
import {
  getGitHubToken,
  getProxyFetch,
  getRepoInfo,
  getCurrentBranch,
  findPRForBranch,
  listOpenPRs,
  type RepoInfo,
  type ProxyFetch,
} from "./github/index.js";

export interface Context {
  token: string;
  repoInfo: RepoInfo;
  proxyFetch: ProxyFetch;
}

export async function bootstrap(): Promise<Context> {
  const token = await getGitHubToken();
  if (!token) {
    throw new Error(
      [
        "GitHub token not found.",
        "Fix: set GITHUB_TOKEN or GH_TOKEN env var, add to .env.local, or run `gh auth login`.",
      ].join(" "),
    );
  }

  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    throw new Error(
      [
        "Could not determine repository.",
        "Fix: run from a git repo with a github.com remote, or set GH_REPO=owner/repo.",
      ].join(" "),
    );
  }

  return { token, repoInfo, proxyFetch: getProxyFetch() };
}

export async function resolvePR(
  ctx: Context,
  prArg?: number,
): Promise<{ prNumber: number; prUrl: string; headSha?: string }> {
  const { repoInfo, token, proxyFetch } = ctx;

  if (prArg) {
    return {
      prNumber: prArg,
      prUrl: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prArg}`,
    };
  }

  const branch = getCurrentBranch();
  if (branch && branch !== "main" && branch !== "master") {
    const pr = await findPRForBranch(repoInfo.owner, repoInfo.repo, branch, token, proxyFetch);
    if (pr) {
      return { prNumber: pr.number, prUrl: pr.html_url, headSha: pr.head.sha };
    }
  }

  const prs = await listOpenPRs(repoInfo.owner, repoInfo.repo, token, proxyFetch);
  if (prs.length === 0) {
    throw new Error(
      "No open PRs found. Fix: pass a PR number as argument, e.g. `bellwether check 123`.",
    );
  }

  const selected = await clack.select({
    message: "Select a PR",
    options: prs.map((pr) => ({
      value: pr.number,
      label: `#${pr.number} ${pr.title}`,
      hint: pr.head.ref,
    })),
  });

  if (clack.isCancel(selected)) {
    process.exit(0);
  }

  const pr = prs.find((p) => p.number === selected)!;
  return { prNumber: pr.number, prUrl: pr.html_url, headSha: pr.head.sha };
}
