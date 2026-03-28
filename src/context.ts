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
} from "./github/index.ts";
import { c } from "./colors.ts";

export interface Context {
  token: string;
  repoInfo: RepoInfo;
  proxyFetch: ProxyFetch;
}

export async function bootstrap(): Promise<Context> {
  const token = await getGitHubToken();
  if (!token) {
    console.error(
      `${c.red}Error: GitHub token not found${c.reset}\nSet GITHUB_TOKEN env var, or authenticate with: gh auth login`,
    );
    return process.exit(1) as never;
  }

  const repoInfo = getRepoInfo();
  if (!repoInfo) {
    console.error(
      `${c.red}Error: Could not determine repository from git remote${c.reset}`,
    );
    return process.exit(1) as never;
  }

  const proxyFetch = getProxyFetch();

  return { token, repoInfo, proxyFetch };
}

export async function resolvePR(
  ctx: Context,
  prArg?: number,
): Promise<{ prNumber: number; prUrl: string }> {
  const { repoInfo, token, proxyFetch } = ctx;

  if (prArg) {
    return {
      prNumber: prArg,
      prUrl: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prArg}`,
    };
  }

  // Try current branch
  const branch = getCurrentBranch();
  if (branch && branch !== "main" && branch !== "master") {
    const pr = await findPRForBranch(
      repoInfo.owner,
      repoInfo.repo,
      branch,
      token,
      proxyFetch,
    );
    if (pr) {
      return { prNumber: pr.number, prUrl: pr.html_url };
    }
  }

  // Interactive selection
  const prs = await listOpenPRs(
    repoInfo.owner,
    repoInfo.repo,
    token,
    proxyFetch,
  );
  if (prs.length === 0) {
    console.error(`${c.red}No open PRs found${c.reset}`);
    return process.exit(1) as never;
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
  return { prNumber: pr.number, prUrl: pr.html_url };
}
