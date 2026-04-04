import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { getProxyAwareFetch } from "./fetch.js";

export type GitHubClient = Octokit;

export function createGitHubClient(token: string): GitHubClient {
  const OctokitWithPlugins = Octokit.plugin(throttling, retry);
  const customFetch = getProxyAwareFetch();

  return new OctokitWithPlugins({
    auth: token,
    userAgent: "bellwether",
    ...(customFetch ? { request: { fetch: customFetch } } : {}),
    throttle: {
      onRateLimit: (retryAfter: number, options: object, _octokit: object, retryCount: number) => {
        const { method, url } = options as { method: string; url: string };
        process.stderr.write(
          `[rate-limit] ${method} ${url} — retry ${retryCount + 1}/3 after ${retryAfter}s\n`,
        );
        return retryCount < 3;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: object,
        _octokit: object,
        retryCount: number,
      ) => {
        const { method, url } = options as { method: string; url: string };
        process.stderr.write(
          `[secondary-rate-limit] ${method} ${url} — retry ${retryCount + 1}/3 after ${retryAfter}s\n`,
        );
        return retryCount < 3;
      },
    },
    retry: { doNotRetry: [400, 401, 404, 422] },
  });
}
