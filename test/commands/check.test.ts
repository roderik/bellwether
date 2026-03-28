import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
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
import { getCISection } from "../../src/commands/ci.js";
import {
  getReviewsList,
  getReviewDetail,
  postReply,
  formatReviewsSection,
} from "../../src/commands/reviews.js";
import { checkCommand } from "../../src/commands/check.js";

const mockResolvePR = vi.mocked(resolvePR);
const mockGetCI = vi.mocked(getCISection);
const mockGetReviews = vi.mocked(getReviewsList);
const mockGetDetail = vi.mocked(getReviewDetail);
const mockPostReply = vi.mocked(postReply);
const mockFormatReviews = vi.mocked(formatReviewsSection);

function makeCtx(optOverrides: Record<string, any> = {}) {
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
    ok: vi.fn((data: any, _meta?: any) => data),
    error: vi.fn((err: any) => err),
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

describe("checkCommand.run", () => {
  it("returns both ci and reviews sections", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.ci).toBeDefined();
    expect(data.reviews).toBeDefined();
    expect(data.ci.sha).toBe("abc");
    expect(data.reviews.total).toBe("0 unresolved, 0 unanswered");
  });

  it("returns CTA for pending checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta.description).toContain("still running");
    expect(meta.cta.commands[0].command).toBe("check --watch");
  });

  it("returns CTA for failing checks", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
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
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta.description).toContain("failing");
  });

  it("no CTA when all passing", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
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
    const data = c.ok.mock.calls[0][0];
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
    mockGetCI.mockResolvedValue({
      status: { ...ciResult.status, pending: 0, failing: 0 },
      flat: ciResult.flat,
    } as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    const result = await checkCommand.run(c);
    expect(result.ci.allPassing).toBe(true);
  });

  it("watch times out", async () => {
    const c = makeCtx({ watch: true, timeout: 0 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockGetCI.mockResolvedValue(ciResult as any);
    mockGetReviews.mockResolvedValue(reviewsResult);
    mockFormatReviews.mockReturnValue(reviewsFlat);

    await checkCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.ci.timedOut).toBe(true);
  });
});
