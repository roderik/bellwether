import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/github/index.js", () => ({
  fetchPRComments: vi.fn(),
  processComments: vi.fn(),
  filterComments: vi.fn(),
  replyToComment: vi.fn(),
  resolveThread: vi.fn(),
}));

import {
  fetchPRComments,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
  type ProcessedComment,
} from "../../src/github/index.js";
import {
  getReviewsList,
  getReviewDetail,
  postReply,
  formatReviewsSection,
  watchForComments,
} from "../../src/commands/reviews.js";

const mockFetchComments = vi.mocked(fetchPRComments);
const mockProcess = vi.mocked(processComments);
const mockFilter = vi.mocked(filterComments);
const mockReply = vi.mocked(replyToComment);
const mockResolve = vi.mocked(resolveThread);

const comment = {
  id: 1,
  type: "review_comment" as const,
  user: "alice",
  isBot: false,
  path: "f.ts",
  line: 10,
  diffHunk: null,
  body: "fix this",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  url: "https://url",
  replies: [],
  hasHumanReply: false,
  hasAnyReply: false,
  isResolved: false,
};

const ctx = { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() };
const filterOpts = { unresolved: false, unanswered: false, botsOnly: false, humansOnly: false };

function setupMocks(comments: ProcessedComment[] = [comment]) {
  mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });
  mockProcess.mockReturnValue(comments);
  mockFilter.mockReturnValue(comments);
}

describe("getReviewsList", () => {
  it("fetches, processes, and filters comments", async () => {
    setupMocks();
    const result = await getReviewsList(ctx, 1, filterOpts);
    expect(result.comments).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("passes unresolved filter", async () => {
    setupMocks();
    await getReviewsList(ctx, 1, { ...filterOpts, unresolved: true });
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: "unresolved" }),
    );
  });

  it("passes unanswered filter", async () => {
    setupMocks();
    await getReviewsList(ctx, 1, { ...filterOpts, unanswered: true });
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: "unanswered" }),
    );
  });

  it("passes null filter when neither set", async () => {
    setupMocks();
    await getReviewsList(ctx, 1, filterOpts);
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: null }),
    );
  });
});

describe("getReviewDetail", () => {
  it("finds comment by ID", async () => {
    setupMocks();
    const result = await getReviewDetail(ctx, 1, 1);
    expect(result?.id).toBe(1);
  });

  it("returns undefined when not found", async () => {
    setupMocks();
    const result = await getReviewDetail(ctx, 1, 999);
    expect(result).toBeUndefined();
  });
});

describe("postReply", () => {
  it("parses id:message and replies", async () => {
    mockReply.mockResolvedValue({ html_url: "https://reply-url" });
    const result = await postReply(ctx, 1, "1:Fixed!", false);
    expect(result.replied).toBe(true);
    expect(result.commentId).toBe(1);
    expect(result.message).toBe("Fixed!");
    expect(result.url).toBe("https://reply-url");
  });

  it("throws on invalid format", async () => {
    await expect(postReply(ctx, 1, "no-colon", false)).rejects.toThrow("--reply format");
  });

  it("resolves thread when requested", async () => {
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockResolvedValue({ resolved: true, threadId: "T1" });
    const result = await postReply(ctx, 1, "1:Done", true);
    expect(result.resolved).toBe(true);
  });

  it("handles resolve failure gracefully", async () => {
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockRejectedValue(new Error("fail"));
    const result = await postReply(ctx, 1, "1:Done", true);
    expect(result.resolved).toBe(false);
    expect(result.resolveError).toBe("fail");
  });

  it("handles resolve returning non-resolved", async () => {
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockResolvedValue({ skipped: true, reason: "not a thread" });
    const result = await postReply(ctx, 1, "1:Done", true);
    expect(result.resolved).toBe(false);
  });
});

describe("formatReviewsSection", () => {
  it("produces flat output with REVIEW keys", () => {
    const result = formatReviewsSection([comment]);
    expect(result.total).toBe("1 unresolved, 1 unanswered");
    expect(result["REVIEW 1 f.ts:10"]).toBe("fix this");
  });

  it("handles comments without path", () => {
    const result = formatReviewsSection([{ ...comment, path: null, line: null }]);
    expect(result["REVIEW 1"]).toBe("fix this");
  });

  it("preserves full comment bodies", () => {
    const longBody = "x".repeat(500);
    const result = formatReviewsSection([{ ...comment, body: longBody }]);
    expect(result["REVIEW 1 f.ts:10"]).toBe(longBody);
  });

  it("counts resolved/replied as not unresolved", () => {
    const result = formatReviewsSection([{ ...comment, isResolved: true }]);
    expect(result.total).toBe("0 unresolved, 1 unanswered");
  });
});

describe("watchForComments", () => {
  it("times out when no new comments", async () => {
    setupMocks();
    const result = await watchForComments(
      { owner: "o", repo: "r", prNumber: 1, token: "tok", proxyFetch: vi.fn() },
      { watchInterval: 0.001, watchTimeout: 0 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.total).toBe(0);
  });

  it("detects new comments with grace period", async () => {
    vi.useFakeTimers();
    mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });

    mockProcess.mockReturnValueOnce([]);
    mockFilter.mockReturnValueOnce([]);

    const newComment = { ...comment, id: 2 };
    const graceComment = { ...comment, id: 3 };
    mockProcess.mockReturnValueOnce([newComment]);
    mockFilter.mockReturnValueOnce([newComment]);
    // Grace period returns the original + a new one
    mockProcess.mockReturnValueOnce([newComment, graceComment]);
    mockFilter.mockReturnValueOnce([newComment, graceComment]);

    const promise = watchForComments(
      { owner: "o", repo: "r", prNumber: 1, token: "tok", proxyFetch: vi.fn() },
      { watchInterval: 0.001, watchTimeout: 10 },
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5100);
    const result = await promise;

    expect(result.total).toBe(2);
    expect(result.newComments).toHaveLength(2);
    expect(result.timedOut).toBe(false);
    vi.useRealTimers();
  });
});
