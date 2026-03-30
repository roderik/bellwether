import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
  updatePRBranch,
  detectLocalConflicts,
  parseMergeTreeOutput,
  extractConflictHunks,
} from "../../src/github/sync.js";

const mockSpawnSync = vi.mocked(spawnSync);

function makeProxyFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  });
}

function spawnOk(stdout = "") {
  return mockSpawnSync.mockReturnValueOnce({
    stdout,
    status: 0,
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
  });
}

function spawnFail() {
  return mockSpawnSync.mockReturnValueOnce({
    stdout: "",
    status: 1,
    stderr: "error",
    pid: 1,
    output: [],
    signal: null,
  });
}

// ---------------------------------------------------------------------------
// updatePRBranch
// ---------------------------------------------------------------------------

describe("updatePRBranch", () => {
  it("returns updated=true on 202", async () => {
    const proxyFetch = makeProxyFetch(202, { message: "Branch was successfully updated.", url: "" });
    const result = await updatePRBranch("o", "r", 1, "sha123", "tok", proxyFetch);
    expect(result).toEqual({ updated: true, message: "Branch was successfully updated." });
    const [url, opts] = proxyFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toContain("/pulls/1/update-branch");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({ expected_head_sha: "sha123" });
  });

  it("omits expected_head_sha when undefined", async () => {
    const proxyFetch = makeProxyFetch(202, { message: "Updated.", url: "" });
    await updatePRBranch("o", "r", 1, undefined, "tok", proxyFetch);
    const [, opts] = proxyFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body)).toEqual({});
  });

  it("returns updated=true on 204", async () => {
    const proxyFetch = makeProxyFetch(204, null);
    const result = await updatePRBranch("o", "r", 1, undefined, "tok", proxyFetch);
    expect(result).toEqual({ updated: true, message: "Branch already up to date" });
  });

  it("returns updated=false on 422", async () => {
    const proxyFetch = makeProxyFetch(422, { message: "merge conflict" });
    const result = await updatePRBranch("o", "r", 1, undefined, "tok", proxyFetch);
    expect(result).toEqual({ updated: false, message: "merge conflict" });
  });

  it("throws on unexpected status", async () => {
    const proxyFetch = makeProxyFetch(500, {});
    await expect(updatePRBranch("o", "r", 1, undefined, "tok", proxyFetch)).rejects.toThrow(
      "update-branch API returned unexpected status: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// detectLocalConflicts
// ---------------------------------------------------------------------------

describe("detectLocalConflicts", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("returns [] when baseBranch starts with -", () => {
    expect(detectLocalConflicts("-evil", "/repo")).toEqual([]);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns [] when git fetch fails", () => {
    spawnFail();
    expect(detectLocalConflicts("main", "/repo")).toEqual([]);
  });

  it("returns [] when cat-file check fails (prHeadRef not available locally)", () => {
    spawnOk(); // fetch ok
    spawnFail(); // cat-file fails
    expect(detectLocalConflicts("main", "/repo")).toEqual([]);
  });

  it("returns [] when merge-base fails", () => {
    spawnOk(); // fetch ok
    spawnOk(); // cat-file ok
    spawnFail(); // merge-base fails
    expect(detectLocalConflicts("main", "/repo")).toEqual([]);
  });

  it("returns [] when merge-base has no output", () => {
    spawnOk(); // fetch ok
    spawnOk(); // cat-file ok
    spawnOk(""); // merge-base empty output
    expect(detectLocalConflicts("main", "/repo")).toEqual([]);
  });

  it("returns [] when merge-tree has no output", () => {
    spawnOk(); // fetch ok
    spawnOk(); // cat-file ok
    spawnOk("abc123"); // merge-base
    spawnOk(""); // merge-tree empty
    expect(detectLocalConflicts("main", "/repo")).toEqual([]);
  });

  it("parses conflicts from merge-tree output", () => {
    spawnOk(); // fetch
    spawnOk(); // cat-file ok
    spawnOk("abc123\n"); // merge-base
    const mergeTreeOutput = [
      "",
      "changed in both",
      "  base   100644 aaa src/foo.ts",
      "  our    100644 bbb src/foo.ts",
      "  their  100644 ccc src/foo.ts",
      "<<<<<<< .our",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> .their",
    ].join("\n");
    spawnOk(mergeTreeOutput); // merge-tree
    const result = detectLocalConflicts("main", "/repo");
    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBe("src/foo.ts");
    expect(result[0]?.count).toBe(1);
    expect(result[0]?.hunks[0]?.ours).toBe("const x = 1;");
    expect(result[0]?.hunks[0]?.theirs).toBe("const x = 2;");
  });
});

// ---------------------------------------------------------------------------
// parseMergeTreeOutput
// ---------------------------------------------------------------------------

describe("parseMergeTreeOutput", () => {
  it("returns [] when no changed-in-both sections", () => {
    expect(parseMergeTreeOutput("some random output\n", 3)).toEqual([]);
  });

  it("skips sections with no our-file line", () => {
    const output = "\nchanged in both\n  base   100644 abc file.ts\n";
    expect(parseMergeTreeOutput(output, 3)).toEqual([]);
  });

  it("skips sections with no conflict hunks", () => {
    const output = [
      "",
      "changed in both",
      "  base   100644 aaa src/clean.ts",
      "  our    100644 bbb src/clean.ts",
      "  their  100644 ccc src/clean.ts",
      "// no conflict markers here",
    ].join("\n");
    expect(parseMergeTreeOutput(output, 3)).toEqual([]);
  });

  it("parses multiple files", () => {
    const section = (file: string) =>
      [
        "",
        "changed in both",
        `  base   100644 aaa ${file}`,
        `  our    100644 bbb ${file}`,
        `  their  100644 ccc ${file}`,
        "<<<<<<< .our",
        "a",
        "=======",
        "b",
        ">>>>>>> .their",
      ].join("\n");

    const output = section("src/a.ts") + section("src/b.ts");
    const result = parseMergeTreeOutput(output, 3);
    expect(result).toHaveLength(2);
    expect(result[0]?.file).toBe("src/a.ts");
    expect(result[1]?.file).toBe("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// extractConflictHunks
// ---------------------------------------------------------------------------

describe("extractConflictHunks", () => {
  it("returns [] for text with no conflict markers", () => {
    expect(extractConflictHunks("no conflicts here", 3)).toEqual([]);
  });

  it("parses a single hunk", () => {
    const text = [
      "<<<<<<< .our",
      "line A",
      "line B",
      "=======",
      "line C",
      ">>>>>>> .their",
    ].join("\n");
    const hunks = extractConflictHunks(text, 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.ours).toBe("line A\nline B");
    expect(hunks[0]?.theirs).toBe("line C");
  });

  it("respects maxHunks limit", () => {
    const hunk = "<<<<<<< .our\na\n=======\nb\n>>>>>>> .their\n";
    const text = hunk.repeat(5);
    expect(extractConflictHunks(text, 2)).toHaveLength(2);
  });

  it("handles empty ours or theirs", () => {
    const text = ["<<<<<<< .our", "=======", "only theirs", ">>>>>>> .their"].join("\n");
    const hunks = extractConflictHunks(text, 3);
    expect(hunks[0]?.ours).toBe("");
    expect(hunks[0]?.theirs).toBe("only theirs");
  });
});
