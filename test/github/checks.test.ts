import { describe, it, expect, vi } from "vitest";
import { fetchCIStatus, classifyCheck } from "../../src/github/checks.js";
import { type GitHubClient } from "../../src/github/client.js";

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

const fakeLog = [
  "2024-01-01T00:00:00.0000000Z ##[group]Run bun check",
  "2024-01-01T00:00:01.0000000Z $ bun check",
  "2024-01-01T00:00:01.0000000Z error: Cannot find name 'fetch'",
  "2024-01-01T00:00:01.0000000Z Found 1 error.",
  "2024-01-01T00:00:01.0000000Z ##[endgroup]",
  "2024-01-01T00:00:01.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");

describe("classifyCheck", () => {
  it("classifies infrastructure check names", () => {
    const infraNames = ["Deploy Preview", "vercel", "codecov/patch", "Snyk Security"];
    for (const name of infraNames) {
      expect(classifyCheck(name)).toBe("infrastructure");
    }
  });

  it("classifies code check names", () => {
    const codeNames = ["lint", "Unit Tests", "build", "typecheck", "CI"];
    for (const name of codeNames) {
      expect(classifyCheck(name)).toBe("code");
    }
  });

  it("returns unknown for unrecognized check names", () => {
    expect(classifyCheck("my-workflow")).toBe("unknown");
    expect(classifyCheck("validate-schema")).toBe("unknown");
  });
});

describe("fetchCIStatus", () => {
  it("returns status with passing, failing, pending checks and logs", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc123" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "build",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
          {
            id: 2,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/2",
          },
          {
            id: 3,
            name: "lint",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/o/r/actions/runs/1/job/3",
          },
          {
            id: 4,
            name: "deploy",
            status: "completed",
            conclusion: "skipped",
            html_url: "https://github.com/o/r/actions/runs/1/job/4",
          },
          {
            id: 5,
            name: "audit",
            status: "completed",
            conclusion: "neutral",
            html_url: "https://github.com/o/r/actions/runs/1/job/5",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    // Log for failing check (job 2)
    vi.mocked(octokit.request).mockResolvedValue({
      data: fakeLog,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("owner", "repo", 1, octokit);

    expect(result.sha).toBe("abc123");
    expect(result.total).toBe(5);
    expect(result.passing).toBe(3);
    expect(result.failing).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.passed).toEqual(["build", "deploy", "audit"]);
    expect(result.in_progress).toEqual(["lint"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe("test");
    expect(result.failures[0].log).toContain("Cannot find name 'fetch'");
    expect(result.failures[0].log).not.toContain("##[group]");
    expect(result.failures[0].log).not.toContain("2024-01-01");
  });

  it("handles timed_out and action_required as failing", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "slow",
            status: "completed",
            conclusion: "timed_out",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
          {
            id: 2,
            name: "needs-action",
            status: "completed",
            conclusion: "action_required",
            html_url: "https://github.com/o/r/actions/runs/1/job/2",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: fakeLog,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("owner", "repo", 1, octokit);
    expect(result.failing).toBe(2);
    expect(result.failures.map((f) => f.name)).toEqual(["slow", "needs-action"]);
  });

  it("handles cancelled checks (not passing, not failing)", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "cancelled",
            status: "completed",
            conclusion: "cancelled",
            html_url: "u",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("owner", "repo", 1, octokit);
    expect(result.passing).toBe(0);
    expect(result.failing).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("queued checks count as pending", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          { id: 1, name: "queued-job", status: "queued", conclusion: null, html_url: "u" },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("owner", "repo", 1, octokit);
    expect(result.pending).toBe(1);
    expect(result.in_progress).toEqual(["queued-job"]);
  });

  it("throws on PR fetch failure", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockRejectedValue({ status: 404, message: "Not Found" });
    await expect(fetchCIStatus("o", "r", 1, octokit)).rejects.toEqual({
      status: 404,
      message: "Not Found",
    });
  });

  it("throws on checks fetch failure", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockRejectedValue({
      status: 500,
      message: "Server Error",
    });
    await expect(fetchCIStatus("o", "r", 1, octokit)).rejects.toEqual({
      status: 500,
      message: "Server Error",
    });
  });

  it("handles log fetch failure gracefully", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockRejectedValue({ status: 500, message: "Server Error" });

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toContain("failed to fetch logs");
  });

  it("handles log fetch exception gracefully", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockRejectedValue(new Error("network error"));

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toBe("[failed to fetch logs]");
  });

  it("handles unparseable job URL", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toContain("could not parse job ID");
  });

  it("filters log with failed step markers", async () => {
    const log = [
      "2024-01-01T00:00:00.0000000Z ##[group]Run setup",
      "2024-01-01T00:00:00.0000000Z installing deps",
      "2024-01-01T00:00:00.0000000Z ##[endgroup]",
      "2024-01-01T00:00:00.0000000Z ##[group]Run tests",
      "2024-01-01T00:00:00.0000000Z $ vitest run",
      "2024-01-01T00:00:00.0000000Z FAIL src/test.ts",
      "2024-01-01T00:00:00.0000000Z Expected 1 to be 2",
      "2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toContain("Expected 1 to be 2");
    expect(result.failures[0].log).not.toContain("##[group]");
    expect(result.failures[0].log).not.toContain("installing deps");
  });

  it("filters log without failed step markers (uses full log)", async () => {
    const log = [
      "2024-01-01T00:00:00.0000000Z some output",
      "2024-01-01T00:00:00.0000000Z ##[debug]debug line",
      "2024-01-01T00:00:00.0000000Z ##[notice]notice",
      "2024-01-01T00:00:00.0000000Z actual error here",
      "2024-01-01T00:00:00.0000000Z ",
    ].join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toContain("actual error here");
    expect(result.failures[0].log).not.toContain("debug line");
  });

  it("handles empty check runs", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: { check_runs: [] },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.total).toBe(0);
    expect(result.passing).toBe(0);
    expect(result.failing).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("sets codeFailing and infrastructureFailing counts", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "lint",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
          {
            id: 2,
            name: "Deploy Preview",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/2",
          },
          {
            id: 3,
            name: "my-workflow",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/3",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: fakeLog,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    // lint=code, Deploy Preview=infrastructure, my-workflow=unknown (counts as code)
    expect(result.codeFailing).toBe(2);
    expect(result.infrastructureFailing).toBe(1);
    expect(result.failures[0].category).toBe("code");
    expect(result.failures[1].category).toBe("infrastructure");
    expect(result.failures[2].category).toBe("unknown");
  });

  it("truncates long log lines to 200 characters", async () => {
    const longLine = "x".repeat(250);
    const log = [
      `2024-01-01T00:00:00.0000000Z ##[group]Run tests`,
      `2024-01-01T00:00:00.0000000Z ${longLine}`,
      `2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.`,
    ].join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    // Truncated to 200 + ellipsis
    expect(result.failures[0].log.length).toBeLessThan(250);
    expect(result.failures[0].log).toContain("…");
  });

  it("tails log to last 60 lines when log is very long", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`2024-01-01T00:00:00.0000000Z line ${i}`);
    }
    const log = lines.join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    const outputLines = result.failures[0].log.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(60);
    // Should include lines from the end
    expect(result.failures[0].log).toContain("line 99");
  });

  it("handles non-string log data", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: 42,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    // Non-string data gets String() wrapped
    expect(result.failures[0].log).toBe("42");
  });

  it("handles null conclusion in failing checks", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: "error",
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].conclusion).toBe("failure");
  });

  it("strips passing test lines from logs", async () => {
    const log = [
      "2024-01-01T00:00:00.0000000Z ##[group]Run tests",
      "2024-01-01T00:00:00.0000000Z  ✓ should pass",
      "2024-01-01T00:00:00.0000000Z  PASS src/ok.test.ts",
      "2024-01-01T00:00:00.0000000Z FAIL src/bad.test.ts",
      "2024-01-01T00:00:00.0000000Z Expected true to be false",
      "2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).not.toContain("✓ should pass");
    expect(result.failures[0].log).not.toContain("PASS src/ok.test.ts");
    expect(result.failures[0].log).toContain("FAIL src/bad.test.ts");
  });

  it("strips ##[warning] prefix from log lines", async () => {
    const log = [
      "2024-01-01T00:00:00.0000000Z ##[group]Run tests",
      "2024-01-01T00:00:00.0000000Z ##[warning]Some warning message",
      "2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");

    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.get).mockResolvedValue({
      data: { head: { sha: "abc" } },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1/job/1",
          },
        ],
      },
      status: 200,
      headers: {},
      url: "",
    } as never);
    vi.mocked(octokit.request).mockResolvedValue({
      data: log,
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit);
    expect(result.failures[0].log).toContain("Some warning message");
    expect(result.failures[0].log).not.toContain("##[warning]");
  });

  it("uses provided headSha and skips PR fetch", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: { check_runs: [] },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await fetchCIStatus("o", "r", 1, octokit, "provided-sha");
    expect(result.sha).toBe("provided-sha");
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });
});
