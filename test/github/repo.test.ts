import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getRepoRoot,
  getRepoInfo,
  getCurrentBranch,
  findPRForBranch,
  listOpenPRs,
  fetchPRMergeState,
  updatePRBranch,
} from "../../src/github/repo.js";
import { type GitHubClient } from "../../src/github/client.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
const mockSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  delete process.env.GH_REPO;
});

function setSpawnResult(stdout: string, status = 0) {
  mockSpawnSync.mockReturnValueOnce({
    stdout,
    status,
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
  });
}

function setSpawnFail() {
  mockSpawnSync.mockReturnValueOnce({
    stdout: "",
    status: 1,
    stderr: "error",
    pid: 1,
    output: [],
    signal: null,
  });
}

function createMockOctokit(overrides = {}) {
  return {
    rest: {
      pulls: {
        list: vi.fn(),
        get: vi.fn(),
        createReplyForReviewComment: vi.fn(),
        listReviewComments: vi.fn(),
        listReviews: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        getComment: vi.fn(),
        updateComment: vi.fn(),
        createComment: vi.fn(),
      },
      checks: { listForRef: vi.fn() },
    },
    paginate: vi.fn(),
    graphql: vi.fn(),
    request: vi.fn(),
    ...overrides,
  } as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// getRepoRoot
// ---------------------------------------------------------------------------

describe("getRepoRoot", () => {
  it("returns trimmed output on success", () => {
    setSpawnResult("/home/user/repo\n");
    expect(getRepoRoot()).toBe("/home/user/repo");
  });

  it("returns null on failure", () => {
    setSpawnFail();
    expect(getRepoRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getRepoInfo
// ---------------------------------------------------------------------------

describe("getRepoInfo", () => {
  it("reads from GH_REPO env", () => {
    process.env.GH_REPO = "myorg/myrepo";
    expect(getRepoInfo()).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("ignores invalid GH_REPO", () => {
    process.env.GH_REPO = "invalid";
    setSpawnFail();
    expect(getRepoInfo()).toBeNull();
  });

  it("parses SSH remote", () => {
    setSpawnResult("git@github.com:owner/repo.git");
    expect(getRepoInfo()).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS remote", () => {
    setSpawnResult("https://github.com/owner/repo.git");
    expect(getRepoInfo()).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses HTTPS remote without .git", () => {
    setSpawnResult("https://github.com/owner/repo");
    expect(getRepoInfo()).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses proxy URL format", () => {
    setSpawnResult("https://proxy.corp.com/git/owner/repo");
    expect(getRepoInfo()).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null when git remote fails", () => {
    setSpawnFail();
    expect(getRepoInfo()).toBeNull();
  });

  it("returns null for unrecognized remote format", () => {
    setSpawnResult("https://gitlab.com/owner/repo");
    expect(getRepoInfo()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
  it("returns branch name", () => {
    setSpawnResult("feature/cool\n");
    expect(getCurrentBranch()).toBe("feature/cool");
  });

  it("returns null on failure", () => {
    setSpawnFail();
    expect(getCurrentBranch()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPRForBranch
// ---------------------------------------------------------------------------

describe("findPRForBranch", () => {
  it("returns first PR", async () => {
    const pr = {
      number: 42,
      title: "test",
      html_url: "url",
      head: { sha: "abc", ref: "feat" },
      state: "open",
    };
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockResolvedValue({
      data: [pr],
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await findPRForBranch("o", "r", "feat", octokit);
    expect(result).toEqual(pr);
  });

  it("returns null when no PRs", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockResolvedValue({
      data: [],
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await findPRForBranch("o", "r", "feat", octokit);
    expect(result).toBeNull();
  });

  it("throws on API error", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockRejectedValue({ status: 404, message: "Not Found" });
    await expect(findPRForBranch("o", "r", "feat", octokit)).rejects.toEqual({
      status: 404,
      message: "Not Found",
    });
  });
});

// ---------------------------------------------------------------------------
// listOpenPRs
// ---------------------------------------------------------------------------

describe("listOpenPRs", () => {
  it("returns PRs", async () => {
    const prs = [
      { number: 1, title: "PR1", html_url: "url1", head: { ref: "b1", sha: "s1" }, state: "open" },
    ];
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockResolvedValue({
      data: prs,
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await listOpenPRs("o", "r", octokit);
    expect(result).toEqual(prs);
  });

  it("throws on API error", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockRejectedValue({ status: 500, message: "Server Error" });
    await expect(listOpenPRs("o", "r", octokit)).rejects.toEqual({
      status: 500,
      message: "Server Error",
    });
  });
});

// ---------------------------------------------------------------------------
// fetchPRMergeState
// ---------------------------------------------------------------------------

describe("fetchPRMergeState", () => {
  it("returns open state with clean mergeable_state", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "open",
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result).toEqual({
      state: "open",
      mergeable: true,
      mergeableState: "clean",
      headSha: "abc123",
      baseBranch: "main",
    });
  });

  it("returns merged state when pr.merged is true", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "closed",
        merged: true,
        mergeable: false,
        mergeable_state: "unknown",
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result.state).toBe("merged");
  });

  it("returns closed state when not merged", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "closed",
        merged: false,
        mergeable: null,
        mergeable_state: "unknown",
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result.state).toBe("closed");
  });

  it("returns null mergeable when still computing", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "open",
        merged: false,
        mergeable: null,
        mergeable_state: "unknown",
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result.mergeable).toBeNull();
    expect(result.mergeableState).toBe("unknown");
  });

  it("returns dirty mergeableState for conflicting PR", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "open",
        merged: false,
        mergeable: false,
        mergeable_state: "dirty",
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result.mergeableState).toBe("dirty");
    expect(result.mergeable).toBe(false);
  });

  it("defaults mergeableState to unknown when field is non-string", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: {
        state: "open",
        merged: false,
        mergeable: null,
        mergeable_state: undefined,
        head: { sha: "abc123" },
        base: { ref: "main" },
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    const result = await fetchPRMergeState("o", "r", 1, octokit);
    expect(result.mergeableState).toBe("unknown");
  });

  it("throws on API error", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockRejectedValue({ status: 404, message: "Not Found" });
    await expect(fetchPRMergeState("o", "r", 1, octokit)).rejects.toEqual({
      status: 404,
      message: "Not Found",
    });
  });
});

describe("updatePRBranch", () => {
  it("resolves on successful update", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.request).mockResolvedValue({
      data: {},
      status: 202,
      headers: {},
      url: "",
    } as never);
    await expect(updatePRBranch("o", "r", 1, octokit)).resolves.toBeUndefined();
  });

  it("resolves on 422 already up to date", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.request).mockRejectedValue({
      status: 422,
      response: { data: { message: "Update is not required" } },
    });
    await expect(updatePRBranch("o", "r", 1, octokit)).resolves.toBeUndefined();
  });

  it("resolves on 422 no commits between", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.request).mockRejectedValue({
      status: 422,
      response: { data: { message: "No commits between main and feat" } },
    });
    await expect(updatePRBranch("o", "r", 1, octokit)).resolves.toBeUndefined();
  });

  it("resolves on 422 up to date", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.request).mockRejectedValue({
      status: 422,
      response: { data: { message: "Already up to date" } },
    });
    await expect(updatePRBranch("o", "r", 1, octokit)).resolves.toBeUndefined();
  });

  it("throws on 422 with non-uptodate message", async () => {
    const octokit = createMockOctokit();
    const error = {
      status: 422,
      response: { data: { message: "Validation Failed" } },
    };
    vi.mocked(octokit.request).mockRejectedValue(error);
    await expect(updatePRBranch("o", "r", 1, octokit)).rejects.toBe(error);
  });

  it("throws on non-422 error", async () => {
    const octokit = createMockOctokit();
    const error = { status: 403, message: "Forbidden" };
    vi.mocked(octokit.request).mockRejectedValue(error);
    await expect(updatePRBranch("o", "r", 1, octokit)).rejects.toBe(error);
  });
});
