import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  getRepoRoot: vi.fn(),
}));

vi.mock("../../src/github/sync.js", () => ({
  updatePRBranch: vi.fn(),
  detectLocalConflicts: vi.fn(),
}));

import { resolvePR } from "../../src/context.js";
import { getRepoRoot } from "../../src/github/index.js";
import { updatePRBranch, detectLocalConflicts } from "../../src/github/sync.js";
import { syncCommand } from "../../src/commands/sync.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockGetRepoRoot = vi.mocked(getRepoRoot);
const mockUpdatePRBranch = vi.mocked(updatePRBranch);
const mockDetectLocalConflicts = vi.mocked(detectLocalConflicts);

function makeMockOctokit(prData: {
  base: { ref: string };
  head: { sha: string };
  mergeable_state: string;
}) {
  const pullsGet = vi.fn();
  pullsGet.mockResolvedValue({ data: prData });
  return {
    rest: { pulls: { get: pullsGet } },
  } as never;
}

function makeCtx(mergeableState: string, optOverrides: Record<string, unknown> = {}) {
  const octokit = makeMockOctokit({
    base: { ref: "main" },
    head: { sha: "abc" },
    mergeable_state: mergeableState,
  });
  return {
    var: { ctx: { repoInfo: { owner: "o", repo: "r" }, octokit } },
    args: { pr: undefined as number | undefined },
    options: { detectConflicts: true, ...optOverrides },
    ok: vi.fn((data: Record<string, unknown>, _meta?: Record<string, unknown>) => data),
    error: vi.fn((err: Record<string, unknown>) => err),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePR.mockResolvedValue({
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    headSha: "abc123",
  });
  mockGetRepoRoot.mockReturnValue("/repo");
  mockDetectLocalConflicts.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Already clean
// ---------------------------------------------------------------------------

describe("sync command — already clean", () => {
  it("returns synced=true with no API calls to update-branch", async () => {
    const c = makeCtx("clean");
    await syncCommand.run(c);
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: true, mergeableState: "clean" }),
    );
    expect(mockUpdatePRBranch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR fetch failure
// ---------------------------------------------------------------------------

describe("sync command — PR fetch failure", () => {
  it("throws when octokit.rest.pulls.get fails", async () => {
    const octokit = {
      rest: {
        pulls: { get: vi.fn().mockRejectedValue({ status: 404, message: "Not Found" }) },
      },
    } as never;
    const c = {
      var: { ctx: { repoInfo: { owner: "o", repo: "r" }, octokit } },
      args: { pr: undefined as number | undefined },
      options: { detectConflicts: true },
      ok: vi.fn((data: Record<string, unknown>) => data),
      error: vi.fn((err: Record<string, unknown>) => err),
    };
    await expect(syncCommand.run(c)).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dirty (merge conflicts)
// ---------------------------------------------------------------------------

describe("sync command — dirty state", () => {
  it("returns synced=false with conflict details", async () => {
    const c = makeCtx("dirty");
    mockDetectLocalConflicts.mockReturnValueOnce([
      {
        file: "src/foo.ts",
        count: 1,
        hunks: [{ ours: "const x = 1;", theirs: "const x = 2;" }],
      },
    ]);
    await syncCommand.run(c);
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({
        synced: false,
        mergeableState: "dirty",
        conflicts: expect.arrayContaining([expect.objectContaining({ file: "src/foo.ts" })]),
      }),
      expect.objectContaining({ cta: expect.anything() }),
    );
    expect(mockUpdatePRBranch).not.toHaveBeenCalled();
  });

  it("skips conflict detection when detectConflicts=false", async () => {
    const c = makeCtx("dirty", { detectConflicts: false });
    await syncCommand.run(c);
    expect(mockDetectLocalConflicts).not.toHaveBeenCalled();
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: false, mergeableState: "dirty" }),
      undefined,
    );
  });

  it("omits conflicts key when none detected", async () => {
    const c = makeCtx("dirty");
    mockDetectLocalConflicts.mockReturnValueOnce([]);
    await syncCommand.run(c);
    const [data] = c.ok.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty("conflicts");
  });

  it("handles missing repoRoot gracefully", async () => {
    const c = makeCtx("dirty");
    mockGetRepoRoot.mockReturnValueOnce(null);
    await syncCommand.run(c);
    expect(mockDetectLocalConflicts).not.toHaveBeenCalled();
    expect(c.ok).toHaveBeenCalledWith(expect.objectContaining({ synced: false }), undefined);
  });
});

// ---------------------------------------------------------------------------
// Behind — successful sync
// ---------------------------------------------------------------------------

describe("sync command — behind state, sync succeeds", () => {
  it("calls update-branch and returns synced=true with CTA", async () => {
    const c = makeCtx("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({
      updated: true,
      message: "Branch was successfully updated.",
    });
    await syncCommand.run(c);
    expect(mockUpdatePRBranch).toHaveBeenCalledWith("o", "r", 42, "abc", expect.anything());
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: true, message: "Branch was successfully updated." }),
      expect.objectContaining({
        cta: expect.objectContaining({ description: expect.stringContaining("synced") }),
      }),
    );
  });

  it("uses post-sync mergeableState from re-fetch when available", async () => {
    // Make the post-sync re-fetch return "clean"
    const octokit = makeMockOctokit({
      base: { ref: "main" },
      head: { sha: "abc" },
      mergeable_state: "behind",
    });
    // Override to return "clean" on second call
    const pullsGet = (octokit as unknown as { rest: { pulls: { get: ReturnType<typeof vi.fn> } } })
      .rest.pulls.get;
    pullsGet.mockResolvedValueOnce({
      data: { base: { ref: "main" }, head: { sha: "abc" }, mergeable_state: "behind" },
    });
    pullsGet.mockResolvedValueOnce({
      data: { base: { ref: "main" }, head: { sha: "abc2" }, mergeable_state: "clean" },
    });
    const c = {
      var: { ctx: { repoInfo: { owner: "o", repo: "r" }, octokit } },
      args: { pr: undefined as number | undefined },
      options: { detectConflicts: true },
      ok: vi.fn((data: Record<string, unknown>, _meta?: Record<string, unknown>) => data),
      error: vi.fn((err: Record<string, unknown>) => err),
    };
    mockUpdatePRBranch.mockResolvedValueOnce({
      updated: true,
      message: "Branch was successfully updated.",
    });
    await syncCommand.run(c);
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: true, mergeableState: "clean" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Behind — updatePRBranch throws
// ---------------------------------------------------------------------------

describe("sync command — behind state, updatePRBranch throws", () => {
  it("returns error when updatePRBranch throws", async () => {
    const c = makeCtx("behind");
    mockUpdatePRBranch.mockRejectedValueOnce(new Error("network timeout"));
    await syncCommand.run(c);
    expect(c.error).toHaveBeenCalledWith({ message: "network timeout" });
  });
});

// ---------------------------------------------------------------------------
// Behind — sync fails (unexpected conflict on API side)
// ---------------------------------------------------------------------------

describe("sync command — behind state, sync fails", () => {
  it("returns synced=false with conflicts when detected", async () => {
    const c = makeCtx("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    mockDetectLocalConflicts.mockReturnValueOnce([
      { file: "README.md", count: 1, hunks: [{ ours: "# Old", theirs: "# New" }] },
    ]);
    await syncCommand.run(c);
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({
        synced: false,
        message: "merge conflict",
        conflicts: expect.arrayContaining([expect.objectContaining({ file: "README.md" })]),
      }),
    );
  });

  it("returns synced=false without conflicts key when none found", async () => {
    const c = makeCtx("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    mockDetectLocalConflicts.mockReturnValueOnce([]);
    await syncCommand.run(c);
    const [data] = c.ok.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty("conflicts");
  });

  it("skips detection when detectConflicts=false", async () => {
    const c = makeCtx("behind", { detectConflicts: false });
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    await syncCommand.run(c);
    expect(mockDetectLocalConflicts).not.toHaveBeenCalled();
    expect(c.ok).toHaveBeenCalledWith(expect.objectContaining({ synced: false }));
  });
});
