import { describe, it, expect, vi } from "vitest";

vi.mock("../src/github/index.js", () => ({
  getGitHubToken: vi.fn(),
  getProxyFetch: vi.fn(() => vi.fn()),
  getRepoInfo: vi.fn(),
  getCurrentBranch: vi.fn(),
  findPRForBranch: vi.fn(),
  listOpenPRs: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

import {
  getGitHubToken,
  getRepoInfo,
  getCurrentBranch,
  findPRForBranch,
  listOpenPRs,
} from "../src/github/index.js";
import * as clack from "@clack/prompts";
import { bootstrap, resolvePR } from "../src/context.js";

const mockGetToken = vi.mocked(getGitHubToken);
const mockGetRepoInfo = vi.mocked(getRepoInfo);
const mockGetBranch = vi.mocked(getCurrentBranch);
const mockFindPR = vi.mocked(findPRForBranch);
const mockListPRs = vi.mocked(listOpenPRs);
const mockSelect = vi.mocked(clack.select);
const mockIsCancel = vi.mocked(clack.isCancel);

function asSelectValue(value: number | symbol) {
  return value as Awaited<ReturnType<typeof clack.select>>;
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
  it("returns context when token and repo found", async () => {
    mockGetToken.mockResolvedValue("tok");
    mockGetRepoInfo.mockReturnValue({ owner: "o", repo: "r" });
    const ctx = await bootstrap();
    expect(ctx.token).toBe("tok");
    expect(ctx.repoInfo).toEqual({ owner: "o", repo: "r" });
  });

  it("throws when no token", async () => {
    mockGetToken.mockResolvedValue(null);
    await expect(bootstrap()).rejects.toThrow("GitHub token not found");
  });

  it("throws when no repo info", async () => {
    mockGetToken.mockResolvedValue("tok");
    mockGetRepoInfo.mockReturnValue(null);
    await expect(bootstrap()).rejects.toThrow("Could not determine repository");
  });
});

// ---------------------------------------------------------------------------
// resolvePR
// ---------------------------------------------------------------------------

describe("resolvePR", () => {
  const ctx = {
    token: "tok",
    repoInfo: { owner: "o", repo: "r" },
    proxyFetch: vi.fn(),
  };

  it("returns directly when prArg provided", async () => {
    const result = await resolvePR(ctx, 42);
    expect(result).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
    });
  });

  it("auto-detects PR from branch", async () => {
    mockGetBranch.mockReturnValue("feat/cool");
    mockFindPR.mockResolvedValue({
      number: 10,
      html_url: "https://github.com/o/r/pull/10",
      title: "Cool",
      head: { sha: "abc", ref: "feat/cool" },
      state: "open",
    });
    const result = await resolvePR(ctx);
    expect(result).toEqual({
      prNumber: 10,
      prUrl: "https://github.com/o/r/pull/10",
      headSha: "abc",
    });
  });

  it("skips branch detection on main", async () => {
    mockGetBranch.mockReturnValue("main");
    mockListPRs.mockResolvedValue([
      {
        number: 5,
        title: "PR 5",
        html_url: "url5",
        head: { sha: "abc", ref: "feat" },
        state: "open",
      },
    ]);
    mockSelect.mockResolvedValue(asSelectValue(5));
    const result = await resolvePR(ctx);
    expect(result.prNumber).toBe(5);
  });

  it("skips branch detection on master", async () => {
    mockGetBranch.mockReturnValue("master");
    mockListPRs.mockResolvedValue([
      {
        number: 7,
        title: "PR 7",
        html_url: "url7",
        head: { sha: "abc", ref: "fix" },
        state: "open",
      },
    ]);
    mockSelect.mockResolvedValue(asSelectValue(7));
    const result = await resolvePR(ctx);
    expect(result.prNumber).toBe(7);
  });

  it("falls back to interactive select when no branch PR", async () => {
    mockGetBranch.mockReturnValue("feat/other");
    mockFindPR.mockResolvedValue(null);
    mockListPRs.mockResolvedValue([
      { number: 3, title: "PR 3", html_url: "url3", head: { sha: "abc", ref: "x" }, state: "open" },
    ]);
    mockSelect.mockResolvedValue(asSelectValue(3));
    const result = await resolvePR(ctx);
    expect(result.prNumber).toBe(3);
  });

  it("falls back to interactive select when branch is null", async () => {
    mockGetBranch.mockReturnValue(null);
    mockListPRs.mockResolvedValue([
      { number: 1, title: "PR 1", html_url: "url1", head: { sha: "abc", ref: "a" }, state: "open" },
    ]);
    mockSelect.mockResolvedValue(asSelectValue(1));
    const result = await resolvePR(ctx);
    expect(result.prNumber).toBe(1);
  });

  it("throws when no open PRs", async () => {
    mockGetBranch.mockReturnValue(null);
    mockListPRs.mockResolvedValue([]);
    await expect(resolvePR(ctx)).rejects.toThrow("No open PRs found");
  });

  it("exits on cancel", async () => {
    mockGetBranch.mockReturnValue(null);
    mockListPRs.mockResolvedValue([
      { number: 1, title: "PR 1", html_url: "url1", head: { sha: "abc", ref: "a" }, state: "open" },
    ]);
    mockIsCancel.mockReturnValue(true);
    mockSelect.mockResolvedValue(asSelectValue(Symbol("cancel")));

    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(resolvePR(ctx)).rejects.toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });
});
