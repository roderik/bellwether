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
      onRateLimit: (_retryAfter: number, _options: object, _octokit: object, retryCount: number) =>
        retryCount < 2,
      onSecondaryRateLimit: (
        _retryAfter: number,
        _options: object,
        _octokit: object,
        retryCount: number,
      ) => retryCount < 2,
    },
    retry: { doNotRetry: [400, 401, 404, 422] },
  });
}
