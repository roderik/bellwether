import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  fetchCIStatus: vi.fn(),
}));

import { resolvePR } from "../../src/context.js";
import { fetchCIStatus } from "../../src/github/index.js";
import { ciCommand } from "../../src/commands/ci.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockFetchCI = vi.mocked(fetchCIStatus);

function makeCtx() {
  return {
    var: { ctx: { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() } },
    args: { pr: undefined as number | undefined },
    options: { watch: false, interval: 1, timeout: 5 },
    ok: vi.fn((data: any, _meta?: any) => data),
  };
}

const baseStatus = {
  sha: "abc",
  total: 3,
  passing: 2,
  failing: 0,
  pending: 1,
  passed: ["build", "lint"],
  in_progress: ["test"],
  failures: [],
};

describe("ciCommand.run", () => {
  it("returns single fetch result", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 1 });

    await ciCommand.run(c);
    expect(c.ok).toHaveBeenCalledTimes(1);
    const data = c.ok.mock.calls[0][0];
    expect(data.pending).toBe(1);
  });

  it("returns CTA for pending checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 1 });

    await ciCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta.description).toContain("still running");
  });

  it("returns CTA for failing checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 0, failing: 1, failures: [{ name: "test", conclusion: "failure", html_url: "u", log: "err" }] });

    await ciCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta.description).toContain("failing");
  });

  it("returns no CTA when all passing", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 0, failing: 0 });

    await ciCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta).toBeUndefined();
  });

  it("watch mode: returns immediately when all passing", async () => {
    const c = makeCtx();
    c.options.watch = true;
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 0, failing: 0 });

    const result = await ciCommand.run(c);
    expect(result.allPassing).toBe(true);
  });

  it("watch mode: returns when failing detected with no pending", async () => {
    const c = makeCtx();
    c.options.watch = true;
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 0, failing: 1, failures: [{ name: "x", conclusion: "failure", html_url: "u", log: "e" }] });

    await ciCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.allPassing).toBe(false);
  });

  it("watch mode: polls then succeeds", async () => {
    vi.useFakeTimers();
    const c = makeCtx();
    c.options.watch = true;
    c.options.interval = 1;
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI
      .mockResolvedValueOnce({ ...baseStatus, pending: 1 }) // first poll: still pending
      .mockResolvedValueOnce({ ...baseStatus, pending: 0, failing: 0 }); // second poll: all pass

    const promise = ciCommand.run(c);
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(result.allPassing).toBe(true);
    vi.useRealTimers();
  });

  it("watch mode: times out", async () => {
    const c = makeCtx();
    c.options.watch = true;
    c.options.timeout = 0; // immediate timeout
    mockResolvePR.mockResolvedValue({ prNumber: 42, prUrl: "url" });
    mockFetchCI.mockResolvedValue({ ...baseStatus, pending: 1 });

    await ciCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.timedOut).toBe(true);
  });
});
