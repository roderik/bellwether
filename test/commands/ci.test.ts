import { describe, it, expect, vi } from "vitest";
import { flatten, getCISection } from "../../src/commands/ci.js";
import { type CIStatus } from "../../src/github/checks.js";

vi.mock("../../src/github/index.js", () => ({
  fetchCIStatus: vi.fn(),
}));

import { fetchCIStatus } from "../../src/github/index.js";
const mockFetchCI = vi.mocked(fetchCIStatus);

const baseStatus: CIStatus = {
  sha: "abc",
  total: 3,
  passing: 2,
  failing: 0,
  pending: 1,
  codeFailing: 0,
  infrastructureFailing: 0,
  passed: ["build", "lint"],
  in_progress: ["test"],
  failures: [],
};

describe("flatten", () => {
  it("produces checks summary string", () => {
    const result = flatten(baseStatus);
    expect(result.checks).toBe("3 total, 2 passing, 0 failing, 1 pending");
    expect(result.sha).toBe("abc");
  });

  it("includes passed names when present", () => {
    const result = flatten(baseStatus);
    expect(result.passed).toBe("build, lint");
  });

  it("includes in_progress names when present", () => {
    const result = flatten(baseStatus);
    expect(result.in_progress).toBe("test");
  });

  it("omits passed when empty", () => {
    const result = flatten({ ...baseStatus, passed: [], passing: 0 });
    expect(result.passed).toBeUndefined();
  });

  it("omits in_progress when empty", () => {
    const result = flatten({ ...baseStatus, in_progress: [], pending: 0 });
    expect(result.in_progress).toBeUndefined();
  });

  it("adds FAIL keys for failures", () => {
    const result = flatten({
      ...baseStatus,
      failing: 1,
      failures: [
        {
          name: "test",
          conclusion: "failure",
          html_url: "u",
          log: "error output",
          category: "code" as const,
        },
      ],
    });
    expect(result["FAIL test"]).toBe("error output");
  });

  it("uses INFRA prefix for infrastructure category failures", () => {
    const result = flatten({
      ...baseStatus,
      failing: 1,
      failures: [
        {
          name: "Deploy Preview",
          conclusion: "failure",
          html_url: "u",
          log: "deploy error",
          category: "infrastructure" as const,
        },
      ],
    });
    expect(result["INFRA Deploy Preview"]).toBe("deploy error");
  });

  it("uses conclusion as prefix for non-failure conclusions", () => {
    const result = flatten({
      ...baseStatus,
      failing: 1,
      failures: [
        {
          name: "slow",
          conclusion: "timed_out",
          html_url: "u",
          log: "timeout",
          category: "code" as const,
        },
      ],
    });
    expect(result["FAIL TIMED_OUT slow"]).toBe("timeout");
  });

  it("merges extra fields", () => {
    const result = flatten(baseStatus, { allPassing: true });
    expect(result.allPassing).toBe(true);
  });

  it("includes infra count in summary when infrastructure failures exist", () => {
    const result = flatten({
      ...baseStatus,
      failing: 1,
      codeFailing: 0,
      infrastructureFailing: 1,
      failures: [
        {
          name: "Deploy Preview",
          conclusion: "failure",
          html_url: "u",
          log: "deploy err",
          category: "infrastructure" as const,
        },
      ],
    });
    expect(result.checks).toContain("0 failing");
    expect(result.checks).toContain("1 infra");
  });
});

describe("getCISection", () => {
  it("fetches CI status and returns both raw and flat", async () => {
    mockFetchCI.mockResolvedValue(baseStatus);
    const ctx = { repoInfo: { owner: "o", repo: "r" }, octokit: {} as never };
    const result = await getCISection(ctx, 1);
    expect(result.status).toEqual(baseStatus);
    expect(result.flat.sha).toBe("abc");
    expect(result.flat.checks).toContain("3 total");
  });

  it("passes headSha to fetchCIStatus", async () => {
    mockFetchCI.mockResolvedValue(baseStatus);
    const ctx = { repoInfo: { owner: "o", repo: "r" }, octokit: {} as never };
    await getCISection(ctx, 1, "sha123");
    expect(mockFetchCI).toHaveBeenCalledWith("o", "r", 1, expect.anything(), "sha123");
  });
});
