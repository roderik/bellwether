import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  ghFetch: vi.fn(),
  getRepoRoot: vi.fn(),
}));

vi.mock("../../src/github/sync.js", () => ({
  updatePRBranch: vi.fn(),
  detectLocalConflicts: vi.fn(),
}));

import { resolvePR } from "../../src/context.js";
import { ghFetch, getRepoRoot } from "../../src/github/index.js";
import { updatePRBranch, detectLocalConflicts } from "../../src/github/sync.js";
import { syncCommand } from "../../src/commands/sync.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockGhFetch = vi.mocked(ghFetch);
const mockGetRepoRoot = vi.mocked(getRepoRoot);
const mockUpdatePRBranch = vi.mocked(updatePRBranch);
const mockDetectLocalConflicts = vi.mocked(detectLocalConflicts);

function makeCtx(optOverrides: Record<string, unknown> = {}) {
  return {
    var: { ctx: { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() } },
    args: { pr: undefined as number | undefined },
    options: { detectConflicts: true, ...optOverrides },
    ok: vi.fn((data: Record<string, unknown>, _meta?: Record<string, unknown>) => data),
    error: vi.fn((err: Record<string, unknown>) => err),
  };
}

function makePRFetch(mergeableState: string) {
  return mockGhFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return { base: { ref: "main" }, head: { sha: "abc" }, mergeable_state: mergeableState };
    },
    async text() {
      return "";
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "https://github.com/o/r/pull/42", headSha: "abc123" });
  mockGetRepoRoot.mockReturnValue("/repo");
  mockDetectLocalConflicts.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Already clean
// ---------------------------------------------------------------------------

describe("sync command — already clean", () => {
  it("returns synced=true with no API calls to update-branch", async () => {
    makePRFetch("clean");
    const c = makeCtx();
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
  it("returns error when ghFetch fails", async () => {
    mockGhFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
      async json() {
        return {};
      },
      async text() {
        return "";
      },
    });
    const c = makeCtx();
    await syncCommand.run(c);
    expect(c.error).toHaveBeenCalledWith({ message: "Failed to fetch PR: 404" });
  });
});

// ---------------------------------------------------------------------------
// Dirty (merge conflicts)
// ---------------------------------------------------------------------------

describe("sync command — dirty state", () => {
  it("returns synced=false with conflict details", async () => {
    makePRFetch("dirty");
    mockDetectLocalConflicts.mockReturnValueOnce([
      {
        file: "src/foo.ts",
        count: 1,
        hunks: [{ ours: "const x = 1;", theirs: "const x = 2;" }],
      },
    ]);
    const c = makeCtx();
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
    makePRFetch("dirty");
    const c = makeCtx({ detectConflicts: false });
    await syncCommand.run(c);
    expect(mockDetectLocalConflicts).not.toHaveBeenCalled();
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: false, mergeableState: "dirty" }),
      undefined,
    );
  });

  it("omits conflicts key when none detected", async () => {
    makePRFetch("dirty");
    mockDetectLocalConflicts.mockReturnValueOnce([]);
    const c = makeCtx();
    await syncCommand.run(c);
    const [data] = c.ok.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty("conflicts");
  });

  it("handles missing repoRoot gracefully", async () => {
    makePRFetch("dirty");
    mockGetRepoRoot.mockReturnValueOnce(null);
    const c = makeCtx();
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
    makePRFetch("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({
      updated: true,
      message: "Branch was successfully updated.",
    });
    const c = makeCtx();
    await syncCommand.run(c);
    expect(mockUpdatePRBranch).toHaveBeenCalledWith("o", "r", 42, "abc", "tok", expect.any(Function));
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: true, message: "Branch was successfully updated." }),
      expect.objectContaining({ cta: expect.objectContaining({ description: expect.stringContaining("synced") }) }),
    );
  });

  it("uses post-sync mergeableState from re-fetch when available", async () => {
    makePRFetch("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({
      updated: true,
      message: "Branch was successfully updated.",
    });
    // Second ghFetch call: post-sync re-fetch returns clean state
    mockGhFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return { base: { ref: "main" }, head: { sha: "abc2" }, mergeable_state: "clean" };
      },
      async text() {
        return "";
      },
    });
    const c = makeCtx();
    await syncCommand.run(c);
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: true, mergeableState: "clean" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Behind — sync fails (unexpected conflict on API side)
// ---------------------------------------------------------------------------

describe("sync command — behind state, sync fails", () => {
  it("returns synced=false with conflicts when detected", async () => {
    makePRFetch("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    mockDetectLocalConflicts.mockReturnValueOnce([
      { file: "README.md", count: 1, hunks: [{ ours: "# Old", theirs: "# New" }] },
    ]);
    const c = makeCtx();
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
    makePRFetch("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    mockDetectLocalConflicts.mockReturnValueOnce([]);
    const c = makeCtx();
    await syncCommand.run(c);
    const [data] = c.ok.mock.calls[0] as [Record<string, unknown>];
    expect(data).not.toHaveProperty("conflicts");
  });

  it("skips detection when detectConflicts=false", async () => {
    makePRFetch("behind");
    mockUpdatePRBranch.mockResolvedValueOnce({ updated: false, message: "merge conflict" });
    const c = makeCtx({ detectConflicts: false });
    await syncCommand.run(c);
    expect(mockDetectLocalConflicts).not.toHaveBeenCalled();
    expect(c.ok).toHaveBeenCalledWith(
      expect.objectContaining({ synced: false }),
    );
  });
});
