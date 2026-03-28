import { describe, it, expect, vi } from "vitest";
import { fetchCIStatus } from "../../src/github/checks.js";

function mockProxyFetch(
  responses: {
    ok: boolean;
    status: number;
    data?: unknown;
    text?: string;
    headers?: Record<string, string>;
  }[],
) {
  let callIdx = 0;
  return vi.fn(async () => {
    const resp = responses[callIdx++];
    const body = resp.text ?? JSON.stringify(resp.data);
    return {
      ok: resp.ok,
      status: resp.status,
      headers: { get: (name: string) => resp.headers?.[name.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => resp.data,
    };
  });
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
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc123" } } },
      {
        ok: true,
        status: 200,
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
      },
      // Log for failing check (id: 2)
      { ok: true, status: 200, text: fakeLog },
    ]);

    const result = await fetchCIStatus("owner", "repo", 1, "tok", pf);

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
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
      { ok: true, status: 200, text: fakeLog },
      { ok: true, status: 200, text: fakeLog },
    ]);

    const result = await fetchCIStatus("owner", "repo", 1, "tok", pf);
    expect(result.failing).toBe(2);
    expect(result.failures.map((f) => f.name)).toEqual(["slow", "needs-action"]);
  });

  it("handles cancelled checks (not passing, not failing)", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
    ]);

    const result = await fetchCIStatus("owner", "repo", 1, "tok", pf);
    expect(result.passing).toBe(0);
    expect(result.failing).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("queued checks count as pending", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
        data: {
          check_runs: [
            { id: 1, name: "queued-job", status: "queued", conclusion: null, html_url: "u" },
          ],
        },
      },
    ]);

    const result = await fetchCIStatus("owner", "repo", 1, "tok", pf);
    expect(result.pending).toBe(1);
    expect(result.in_progress).toEqual(["queued-job"]);
  });

  it("throws on PR fetch failure", async () => {
    const pf = mockProxyFetch([{ ok: false, status: 404, data: {} }]);
    await expect(fetchCIStatus("o", "r", 1, "tok", pf)).rejects.toThrow("Failed to fetch PR: 404");
  });

  it("throws on checks fetch failure", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      { ok: false, status: 500, data: {} },
    ]);
    await expect(fetchCIStatus("o", "r", 1, "tok", pf)).rejects.toThrow(
      "Failed to fetch checks: 500",
    );
  });

  it("handles log fetch failure gracefully", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
      { ok: false, status: 500, text: "" },
    ]);

    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
    expect(result.failures[0].log).toContain("failed to fetch logs");
  });

  it("handles log fetch exception gracefully", async () => {
    let callIdx = 0;
    const pf = vi.fn(async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
          json: async () => ({ head: { sha: "abc" } }),
        };
      }
      if (callIdx === 2) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
          json: async () => ({
            check_runs: [
              {
                id: 1,
                name: "test",
                status: "completed",
                conclusion: "failure",
                html_url: "https://github.com/o/r/actions/runs/1/job/1",
              },
            ],
          }),
        };
      }
      throw new Error("network error");
    });
    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
    expect(result.failures[0].log).toBe("[failed to fetch logs]");
  });

  it("handles unparseable job URL", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
    ]);
    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
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

    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
      { ok: true, status: 200, text: log },
    ]);

    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
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

    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      {
        ok: true,
        status: 200,
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
      },
      { ok: true, status: 200, text: log },
    ]);

    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
    expect(result.failures[0].log).toContain("actual error here");
    expect(result.failures[0].log).not.toContain("debug line");
  });

  it("handles empty check runs", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { head: { sha: "abc" } } },
      { ok: true, status: 200, data: { check_runs: [] } },
    ]);

    const result = await fetchCIStatus("o", "r", 1, "tok", pf);
    expect(result.total).toBe(0);
    expect(result.passing).toBe(0);
    expect(result.failing).toBe(0);
    expect(result.pending).toBe(0);
  });
});
