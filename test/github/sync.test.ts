import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("../../src/github/fetch.js", () => ({
  ghFetch: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ghFetch } from "../../src/github/fetch.js";
import { fetchPRBase, syncBranchWithBase, parseConflicts } from "../../src/github/sync.js";

const mockSpawn = vi.mocked(spawnSync);
const mockReadFile = vi.mocked(readFileSync);
const mockGhFetch = vi.mocked(ghFetch);

function makeSpawnResult(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr, pid: 1, output: [], signal: null };
}

describe("fetchPRBase", () => {
  it("returns base ref and sha", async () => {
    mockGhFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ base: { ref: "main", sha: "abc123" } }),
    } as any);

    const result = await fetchPRBase("owner", "repo", 42, "token", vi.fn());
    expect(result).toEqual({ base: "main", baseSha: "abc123" });
  });

  it("throws on non-ok response", async () => {
    mockGhFetch.mockResolvedValue({ ok: false, status: 404 } as any);
    await expect(fetchPRBase("owner", "repo", 42, "token", vi.fn())).rejects.toThrow("404");
  });
});

describe("syncBranchWithBase", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("returns success when fetch and rebase both succeed", () => {
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(0, "fetched"))
      .mockReturnValueOnce(makeSpawnResult(0, "rebased"));

    const result = syncBranchWithBase("main", "rebase");
    expect(result.success).toBe(true);
    expect(result.hasConflicts).toBe(false);
  });

  it("returns success when fetch and merge both succeed", () => {
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(0, "fetched"))
      .mockReturnValueOnce(makeSpawnResult(0, "merged"));

    const result = syncBranchWithBase("main", "merge");
    expect(result.success).toBe(true);
  });

  it("returns failure with hasConflicts=true when conflict files exist", () => {
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(0)) // fetch
      .mockReturnValueOnce(makeSpawnResult(1, "", "CONFLICT")) // rebase
      .mockReturnValueOnce(makeSpawnResult(0, "src/foo.ts\n")); // diff --name-only

    const result = syncBranchWithBase("main", "rebase");
    expect(result.success).toBe(false);
    expect(result.hasConflicts).toBe(true);
  });

  it("returns failure with hasConflicts=false when fetch fails", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(1, "", "fetch error"));

    const result = syncBranchWithBase("main", "rebase");
    expect(result.success).toBe(false);
    expect(result.hasConflicts).toBe(false);
    expect(result.output).toContain("fetch failed");
  });

  it("returns failure with hasConflicts=false when op fails with no conflict files", () => {
    mockSpawn
      .mockReturnValueOnce(makeSpawnResult(0)) // fetch
      .mockReturnValueOnce(makeSpawnResult(1, "", "error")) // rebase
      .mockReturnValueOnce(makeSpawnResult(0, "")); // no conflict files

    const result = syncBranchWithBase("main", "rebase");
    expect(result.success).toBe(false);
    expect(result.hasConflicts).toBe(false);
  });
});

describe("parseConflicts", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockReadFile.mockReset();
  });

  it("returns empty report when no conflicted files", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, ""));
    const result = parseConflicts();
    expect(result.count).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.details).toEqual({});
  });

  it("parses conflict hunks from a file", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "src/foo.ts\n"));
    mockReadFile.mockReturnValueOnce(
      [
        "before",
        "<<<<<<< HEAD",
        "const x = 1;",
        "=======",
        "const x = 2;",
        ">>>>>>> main",
        "after",
      ].join("\n") as any,
    );

    const result = parseConflicts();
    expect(result.count).toBe(1);
    expect(result.files).toEqual(["src/foo.ts"]);
    expect(result.details["src/foo.ts"]).toBeDefined();
    expect(result.details["src/foo.ts"][0]).toContain("ours:");
    expect(result.details["src/foo.ts"][0]).toContain("theirs:");
    expect(result.details["src/foo.ts"][0]).toContain("const x = 1;");
    expect(result.details["src/foo.ts"][0]).toContain("const x = 2;");
  });

  it("handles multiple hunks in one file", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "src/bar.ts\n"));
    mockReadFile.mockReturnValueOnce(
      [
        "<<<<<<< HEAD",
        "a",
        "=======",
        "b",
        ">>>>>>> main",
        "middle",
        "<<<<<<< HEAD",
        "c",
        "=======",
        "d",
        ">>>>>>> main",
      ].join("\n") as any,
    );

    const result = parseConflicts();
    expect(result.details["src/bar.ts"]).toHaveLength(2);
  });

  it("handles multiple conflicted files", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "a.ts\nb.ts\n"));
    mockReadFile
      .mockReturnValueOnce("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n" as any)
      .mockReturnValueOnce("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n" as any);

    const result = parseConflicts();
    expect(result.count).toBe(2);
    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });

  it("truncates long lines", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "f.ts\n"));
    const longLine = "x".repeat(200);
    mockReadFile.mockReturnValueOnce(
      `<<<<<<< HEAD\n${longLine}\n=======\nshort\n>>>>>>> main\n` as any,
    );

    const result = parseConflicts();
    const hunk = result.details["f.ts"][0];
    // Should be truncated to MAX_LINE_LEN + ellipsis
    expect(hunk).toContain("…");
  });

  it("marks files that cannot be read", () => {
    mockSpawn.mockReturnValueOnce(makeSpawnResult(0, "missing.ts\n"));
    mockReadFile.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const result = parseConflicts();
    expect(result.details["missing.ts"]).toEqual(["(could not read file)"]);
  });
});
