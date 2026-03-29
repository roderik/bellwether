import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  getRepoRoot: vi.fn(),
  fetchPRBase: vi.fn(),
  syncBranchWithBase: vi.fn(),
  parseConflicts: vi.fn(),
}));

import { resolvePR } from "../../src/context.js";
import {
  getRepoRoot,
  fetchPRBase,
  syncBranchWithBase,
  parseConflicts,
} from "../../src/github/index.js";
import { syncCommand } from "../../src/commands/sync.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockGetRepoRoot = vi.mocked(getRepoRoot);
const mockFetchPRBase = vi.mocked(fetchPRBase);
const mockSyncBranch = vi.mocked(syncBranchWithBase);
const mockParseConflicts = vi.mocked(parseConflicts);

function makeCtx(optOverrides: Record<string, unknown> = {}) {
  return {
    var: { ctx: { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() } },
    args: { pr: undefined as number | undefined },
    options: { strategy: "rebase" as "rebase" | "merge", ...optOverrides },
    ok: vi.fn((data: Record<string, unknown>, _meta?: Record<string, unknown>) => data),
    error: vi.fn((err: Record<string, unknown>) => err),
  };
}

describe("syncCommand.run", () => {
  it("errors when not in a git repo", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue(null);

    await syncCommand.run(c);
    expect(c.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("git repository") }),
    );
  });

  it("returns synced=true on success", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({ success: true, hasConflicts: false, output: "rebased" });

    await syncCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.synced).toBe(true);
    expect(data.base).toBe("main");
    expect(data.strategy).toBe("rebase");
  });

  it("includes CTA to watch CI on success", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({ success: true, hasConflicts: false, output: "" });

    await syncCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.commands[0].command).toBe("check --watch");
  });

  it("returns conflict report when hasConflicts=true", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({ success: false, hasConflicts: true, output: "CONFLICT" });
    mockParseConflicts.mockReturnValue({
      count: 1,
      files: ["src/foo.ts"],
      details: { "src/foo.ts": ["hunk1: ours: a | theirs: b"] },
    });

    await syncCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.synced).toBe(false);
    expect(data.conflicts.count).toBe(1);
    expect(data.conflicts.files).toEqual(["src/foo.ts"]);
  });

  it("includes rebase --continue CTA when conflicts on rebase", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({ success: false, hasConflicts: true, output: "" });
    mockParseConflicts.mockReturnValue({ count: 1, files: ["f.ts"], details: {} });

    await syncCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.commands[0].command).toBe("git rebase --continue");
  });

  it("includes merge --continue CTA when conflicts on merge strategy", async () => {
    const c = makeCtx({ strategy: "merge" });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({ success: false, hasConflicts: true, output: "" });
    mockParseConflicts.mockReturnValue({ count: 1, files: ["f.ts"], details: {} });

    await syncCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.commands[0].command).toBe("git merge --continue");
  });

  it("errors when sync fails without conflicts", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "main", baseSha: "abc" });
    mockSyncBranch.mockReturnValue({
      success: false,
      hasConflicts: false,
      output: "network error",
    });

    await syncCommand.run(c);
    expect(c.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("network error") }),
    );
  });

  it("uses PR number from args", async () => {
    const c = { ...makeCtx(), args: { pr: 99 } };
    mockResolvePR.mockResolvedValue({ prNumber: 99, prUrl: "url" });
    mockGetRepoRoot.mockReturnValue("/repo");
    mockFetchPRBase.mockResolvedValue({ base: "develop", baseSha: "xyz" });
    mockSyncBranch.mockReturnValue({ success: true, hasConflicts: false, output: "" });

    await syncCommand.run(c);
    expect(mockFetchPRBase).toHaveBeenCalledWith("o", "r", 99, "tok", expect.any(Function));
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.base).toBe("develop");
  });
});
