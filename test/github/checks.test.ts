import { describe, it, expect, vi } from "vitest";
import { fetchCIStatus } from "../../src/github/checks.js";
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
