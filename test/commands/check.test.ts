import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  fetchPRMergeState: vi.fn(),
  updatePRBranch: vi.fn(),
}));

vi.mock("../../src/commands/ci.js", () => ({
  getCISection: vi.fn(),
}));

vi.mock("../../src/commands/reviews.js", () => ({
  getReviewsList: vi.fn(),
  getReviewDetail: vi.fn(),
  postReply: vi.fn(),
  formatReviewsSection: vi.fn(),
  commentSchema: { optional: () => ({}) },
}));

import { resolvePR } from "../../src/context.js";
import { fetchPRMergeState, updatePRBranch } from "../../src/github/index.js";
import { getCISection } from "../../src/commands/ci.js";
import {
  getReviewsList,
  getReviewDetail,
  postReply,
  formatReviewsSection,
} from "../../src/commands/reviews.js";
import { checkCommand } from "../../src/commands/check.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockFetchPRMergeState = vi.mocked(fetchPRMergeState);
const mockUpdatePRBranch = vi.mocked(updatePRBranch);
const mockGetCI = vi.mocked(getCISection);
const mockGetReviews = vi.mocked(getReviewsList);
const mockGetDetail = vi.mocked(getReviewDetail);
const mockPostReply = vi.mocked(postReply);
const mockFormatReviews = vi.mocked(formatReviewsSection);

function makeCtx(optOverrides: Record<string, unknown> = {}) {
  return {
    var: { ctx: { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() } },
    args: { pr: undefined as number | undefined },
    options: {
      watch: false,
      interval: 1,
      timeout: 5,
      unresolved: false,
      unanswered: false,
      botsOnly: false,
      humansOnly: false,
      reply: undefined as string | undefined,
      resolve: false,
      detail: undefined as number | undefined,
      ...optOverrides,
    },
    ok: vi.fn((data: Record<string, unknown>, _meta?: Record<string, unknown>) => data),
    error: vi.fn((err: Record<string, unknown>) => err),
  };
}

const ciResult = {
  status: {
    sha: "abc",
    total: 3,
    passing: 2,
    failing: 0,
    pending: 1,
    passed: ["build"],
    in_progress: ["test"],
    failures: [],
  },
  flat: {
    sha: "abc",
    checks: "3 total, 2 passing, 0 failing, 1 pending",
    passed: "build",
    in_progress: "test",
  },
};

const reviewsResult = { comments: [], total: 0 };
const reviewsFlat = { total: "0 unresolved, 0 unanswered" };

const mergeStateClean = {
  state: "open" as const,
  mergeable: true,
  mergeableState: "clean",
  headSha: "abc123",
  baseBranch: "main",
};

const mergeStateDirty = {
  state: "open" as const,
  mergeable: false,
  mergeableState: "dirty",
  headSha: "abc123",
  baseBranch: "main",
};

describe("checkCommand.run", () => {
  it("returns both ci and reviews sections", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.ci).toBeDefined();
    expect(data.reviews).toBeDefined();
    expect(data.ci.sha).toBe("abc");
    expect(data.reviews.total).toBe("0 unresolved, 0 unanswered");
  });

  it("returns CTA for pending checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.description).toContain("still running");
    expect(meta.cta.commands[0].command).toBe("check --watch");
  });

  it("returns CTA for failing checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: {
        ...ciResult.status,
        pending: 0,
        failing: 1,
        failures: [{ name: "x", conclusion: "failure", html_url: "u", log: "e" }],
      },
      flat: { ...ciResult.flat, "FAIL x": "e" },
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.description).toContain("failing");
  });

  it("no CTA when all passing", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta).toBeUndefined();
  });

  // Reply mode
  it("delegates to postReply", async () => {
    const c = makeCtx({ reply: "1:Fixed!" });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockPostReply.mockResolvedValue({
      replied: true,
      commentId: 1,
      message: "Fixed!",
      url: "https://reply-url",
    });

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.replied).toBe(true);
    expect(data.url).toBe("https://reply-url");
  });

  // Detail mode
  it("delegates to getReviewDetail", async () => {
    const c = makeCtx({ detail: 456 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetDetail.mockResolvedValue({ id: 456, body: "fix this" } as any);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.comment.id).toBe(456);
  });

  it("errors when detail comment not found", async () => {
    const c = makeCtx({ detail: 999 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetDetail.mockResolvedValue(undefined);

    await checkCommand.run(c);
    expect(c.error).toHaveBeenCalledTimes(1);
  });

  // Watch mode
  it("watch returns immediately when all passing", async () => {
    const c = makeCtx({ watch: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    const result = (await checkCommand.run(c)) as any;
    expect(result.ci.allPassing).toBe(true);
  });

  it("watch returns failing with CTA when all checks done", async () => {
    const c = makeCtx({ watch: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: {
        ...ciResult.status,
        pending: 0,
        failing: 1,
        failures: [{ name: "x", conclusion: "failure", html_url: "u", log: "e" }],
      },
      flat: { ...ciResult.flat, "FAIL x": "e" },
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.ci.allPassing).toBe(false);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.description).toContain("Failed");
  });

  it("watch polls then succeeds", async () => {
    vi.useFakeTimers();
    const c = makeCtx({ watch: true, interval: 1 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValueOnce(ciResult as any).mockResolvedValueOnce({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    const promise = checkCommand.run(c);
    await vi.advanceTimersByTimeAsync(1100);
    const result = (await promise) as any;

    expect(result.ci.allPassing).toBe(true);
    vi.useRealTimers();
  });

  it("watch times out", async () => {
    const c = makeCtx({ watch: true, timeout: 0 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.ci.timedOut).toBe(true);
    const meta = c.ok.mock.calls[0][1] as any;
    expect(meta.cta.description).toContain("Timed out");
  });

  // PR merge state
  it("includes pr section with ready=true when all conditions met", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.pr).toEqual({
      state: "open",
      mergeable: "clean",
      ready: true,
    });
  });

  it("includes conflict info when mergeableState is dirty", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateDirty);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.pr.state).toBe("open");
    expect(data.pr.mergeable).toBe("dirty");
    expect(data.pr.ready).toBe(false);
    expect(data.pr.conflict).toEqual({
      base: "main",
      resolution: "git fetch origin && git merge origin/main && git push",
    });
  });

  it("calls updatePRBranch and returns synced=true when branch is behind", async () => {
    const c = makeCtx();
    const mergeStateBehind = {
      ...mergeStateClean,
      mergeableState: "behind",
    };
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateBehind);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);
    mockUpdatePRBranch.mockResolvedValue(undefined);

    await checkCommand.run(c);
    expect(mockUpdatePRBranch).toHaveBeenCalledWith("o", "r", 1, "tok", expect.any(Function));
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.pr.synced).toBe(true);
  });

  it("watch exits with conflict info when mergeableState is dirty", async () => {
    const c = makeCtx({ watch: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateDirty);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    const result = (await checkCommand.run(c)) as any;
    expect(result.pr.mergeable).toBe("dirty");
    expect(result.pr.conflict).toEqual({
      base: "main",
      resolution: "git fetch origin && git merge origin/main && git push",
    });
  });

  it("watch calls updatePRBranch once when branch is behind then continues", async () => {
    const c = makeCtx({ watch: true });
    const mergeStateBehind = { ...mergeStateClean, mergeableState: "behind" };
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    // First call returns behind, second returns clean with CI done
    mockFetchPRMergeState
      .mockResolvedValueOnce(mergeStateBehind)
      .mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);
    mockUpdatePRBranch.mockResolvedValue(undefined);

    const result = (await checkCommand.run(c)) as any;
    expect(mockUpdatePRBranch).toHaveBeenCalledTimes(1);
    expect(result.pr.synced).toBe(true);
    expect(result.pr.ready).toBe(true);
  });

  it("includes pr section with ready=false when CI failing", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: {
        ...ciResult.status,
        pending: 0,
        failing: 1,
        failures: [{ name: "x", conclusion: "failure", html_url: "u", log: "e" }],
      },
      flat: { ...ciResult.flat, "FAIL x": "e" },
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.pr.ready).toBe(false);
  });

  it("includes pr section with ready=false when unresolved reviews exist", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue({
      comments: [{ id: 1, isResolved: false, hasHumanReply: false, hasAnyReply: false } as any],
      total: 1,
    });
    mockFormatReviews.mockReturnValue({ total: "1 unresolved, 1 unanswered" });

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0] as any;
    expect(data.pr.ready).toBe(false);
  });

  it("watch includes pr section", async () => {
    const c = makeCtx({ watch: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchPRMergeState.mockResolvedValue(mergeStateClean);
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    const result = (await checkCommand.run(c)) as any;
    expect(result.pr).toEqual({
      state: "open",
      mergeable: "clean",
      ready: true,
    });
  });
});
