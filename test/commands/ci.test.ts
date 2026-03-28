import { describe, it, expect } from "vitest";
import { flatten } from "../../src/commands/ci.js";
import { type CIStatus } from "../../src/github/checks.js";

const baseStatus: CIStatus = {
  sha: "abc",
  total: 3,
  passing: 2,
  failing: 0,
  pending: 1,
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
      failures: [{ name: "test", conclusion: "failure", html_url: "u", log: "error output" }],
    });
    expect(result["FAIL test"]).toBe("error output");
  });

  it("uses conclusion as prefix for non-failure conclusions", () => {
    const result = flatten({
      ...baseStatus,
      failing: 1,
      failures: [{ name: "slow", conclusion: "timed_out", html_url: "u", log: "timeout" }],
    });
    expect(result["TIMED_OUT slow"]).toBe("timeout");
  });

  it("merges extra fields", () => {
    const result = flatten(baseStatus, { allPassing: true });
    expect(result.allPassing).toBe(true);
  });
});
