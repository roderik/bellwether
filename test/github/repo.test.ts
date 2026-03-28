import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRepoRoot, getRepoInfo, getCurrentBranch, findPRForBranch, listOpenPRs } from "../../src/github/repo.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
const mockSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  delete process.env.GH_REPO;
});

function setSpawnResult(stdout: string, status = 0) {
  mockSpawnSync.mockReturnValueOnce({ stdout, status, stderr: "", pid: 1, output: [], signal: null });
}

function setSpawnFail() {
  mockSpawnSync.mockReturnValueOnce({ stdout: "", status: 1, stderr: "error", pid: 1, output: [], signal: null });
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
  function mockFetch(data: any, ok = true, status = 200) {
    return vi.fn(async () => ({
      ok,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(data),
      json: async () => data,
    }));
  }

  it("returns first PR", async () => {
    const pr = { number: 42, title: "test", html_url: "url", head: { ref: "feat" }, state: "open" };
    const pf = mockFetch([pr]);
    const result = await findPRForBranch("o", "r", "feat", "tok", pf);
    expect(result).toEqual(pr);
  });

  it("returns null when no PRs", async () => {
    const pf = mockFetch([]);
    const result = await findPRForBranch("o", "r", "feat", "tok", pf);
    expect(result).toBeNull();
  });

  it("throws on API error", async () => {
    const pf = mockFetch(null, false, 404);
    await expect(findPRForBranch("o", "r", "feat", "tok", pf)).rejects.toThrow("Failed to find PR: 404");
  });
});

// ---------------------------------------------------------------------------
// listOpenPRs
// ---------------------------------------------------------------------------

describe("listOpenPRs", () => {
  it("returns PRs", async () => {
    const prs = [{ number: 1 }];
    const pf = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(prs),
      json: async () => prs,
    }));
    const result = await listOpenPRs("o", "r", "tok", pf);
    expect(result).toEqual(prs);
  });

  it("throws on API error", async () => {
    const pf = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "err",
      json: async () => ({}),
    }));
    await expect(listOpenPRs("o", "r", "tok", pf)).rejects.toThrow("Failed to list PRs: 500");
  });
});
