import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/context.js", () => ({
  resolvePR: vi.fn(),
}));

vi.mock("../../src/github/index.js", () => ({
  fetchPRComments: vi.fn(),
  processComments: vi.fn(),
  filterComments: vi.fn(),
  replyToComment: vi.fn(),
  resolveThread: vi.fn(),
}));

import { resolvePR } from "../../src/context.js";
import {
  fetchPRComments,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
} from "../../src/github/index.js";
import { reviewsCommand } from "../../src/commands/reviews.js";

const mockResolvePR = vi.mocked(resolvePR);
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

function makeCtx(optOverrides: Record<string, any> = {}) {
  return {
    var: { ctx: { token: "tok", repoInfo: { owner: "o", repo: "r" }, proxyFetch: vi.fn() } },
    args: { pr: undefined as number | undefined },
    options: {
      unresolved: false,
      unanswered: false,
      botsOnly: false,
      humansOnly: false,
      reply: undefined as string | undefined,
      resolve: false,
      detail: undefined as number | undefined,
      watch: false,
      interval: 1,
      timeout: 1,
      ...optOverrides,
    },
    ok: vi.fn((data: any, _meta?: any) => data),
    error: vi.fn((err: any) => err),
  };
}

function setupCommentMocks(comments: any[] = [comment]) {
  mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });
  mockProcess.mockReturnValue(comments);
  mockFilter.mockReturnValue(comments);
}

describe("reviewsCommand.run", () => {
  // List mode
  it("lists comments by default", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    expect(c.ok).toHaveBeenCalledTimes(1);
    const data = c.ok.mock.calls[0][0];
    expect(data.comments).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it("returns no CTA when empty", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks([]);

    await reviewsCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta).toBeUndefined();
  });

  it("passes unresolved filter", async () => {
    const c = makeCtx({ unresolved: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: "unresolved" }),
    );
  });

  it("passes unanswered filter", async () => {
    const c = makeCtx({ unanswered: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: "unanswered" }),
    );
  });

  it("passes null filter when neither set", async () => {
    const c = makeCtx();
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    expect(mockFilter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: null }),
    );
  });

  // Detail mode
  it("shows comment detail", async () => {
    const c = makeCtx({ detail: 1 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.comment.id).toBe(1);
  });

  it("errors when detail comment not found", async () => {
    const c = makeCtx({ detail: 999 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    expect(c.error).toHaveBeenCalledWith(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  // Reply mode
  it("replies to comment", async () => {
    const c = makeCtx({ reply: "1:Fixed!" });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockReply.mockResolvedValue({ html_url: "https://reply-url" });

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.replied).toBe(true);
    expect(data.commentId).toBe(1);
    expect(data.url).toBe("https://reply-url");
  });

  it("errors on invalid reply format", async () => {
    const c = makeCtx({ reply: "no-colon" });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });

    await reviewsCommand.run(c);
    expect(c.error).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_ARGS" }));
  });

  it("replies and resolves", async () => {
    const c = makeCtx({ reply: "1:Done", resolve: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockResolvedValue({ resolved: true, threadId: "T1" });

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.resolved).toBe(true);
  });

  it("handles resolve failure gracefully", async () => {
    const c = makeCtx({ reply: "1:Done", resolve: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockRejectedValue(new Error("fail"));

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.resolved).toBe(false);
  });

  it("handles resolve returning skipped", async () => {
    const c = makeCtx({ reply: "1:Done", resolve: true });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockReply.mockResolvedValue({ html_url: "https://url" });
    mockResolve.mockResolvedValue({ skipped: true, reason: "not a thread" });

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.resolved).toBe(false);
  });

  // Watch mode
  it("watch returns timedOut when no new comments", async () => {
    const c = makeCtx({ watch: true, interval: 0.001, timeout: 0 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    const data = c.ok.mock.calls[0][0];
    expect(data.timedOut).toBe(true);
  });

  it("watch returns new comments when detected", async () => {
    vi.useFakeTimers();
    const c = makeCtx({ watch: true, interval: 0.001, timeout: 10 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });

    mockProcess.mockReturnValueOnce([]);
    mockFilter.mockReturnValueOnce([]);

    const newComment = { ...comment, id: 2 };
    mockProcess.mockReturnValueOnce([newComment]);
    mockFilter.mockReturnValueOnce([newComment]);
    mockProcess.mockReturnValueOnce([newComment]);
    mockFilter.mockReturnValueOnce([newComment]);

    const promise = reviewsCommand.run(c);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5100);
    await promise;

    expect(c.ok).toHaveBeenCalledTimes(1);
    const result = c.ok.mock.calls[0][0];
    expect(result.total).toBe(1);
    expect(result.newComments).toHaveLength(1);
    expect(result.timedOut).toBe(false);
    vi.useRealTimers();
  });

  it("watch grace period catches additional comments", async () => {
    vi.useFakeTimers();
    const c = makeCtx({ watch: true, interval: 0.001, timeout: 10 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });

    mockProcess.mockReturnValueOnce([]);
    mockFilter.mockReturnValueOnce([]);

    const c1 = { ...comment, id: 2 };
    mockProcess.mockReturnValueOnce([c1]);
    mockFilter.mockReturnValueOnce([c1]);

    const c2 = { ...comment, id: 3 };
    mockProcess.mockReturnValueOnce([c1, c2]);
    mockFilter.mockReturnValueOnce([c1, c2]);

    const promise = reviewsCommand.run(c);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5100);
    await promise;

    const result = c.ok.mock.calls[0][0];
    expect(result.total).toBe(2);
    expect(result.newComments).toHaveLength(2);
    vi.useRealTimers();
  });

  it("watch returns CTA when new comments found", async () => {
    vi.useFakeTimers();
    const c = makeCtx({ watch: true, interval: 0.001, timeout: 10 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    mockFetchComments.mockResolvedValue({ reviewComments: [], issueComments: [], reviews: [] });

    mockProcess.mockReturnValueOnce([]);
    mockFilter.mockReturnValueOnce([]);

    const newComment = { ...comment, id: 2 };
    mockProcess.mockReturnValueOnce([newComment]);
    mockFilter.mockReturnValueOnce([newComment]);
    mockProcess.mockReturnValueOnce([newComment]);
    mockFilter.mockReturnValueOnce([newComment]);

    const promise = reviewsCommand.run(c);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5100);
    await promise;

    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta.description).toContain("Process new comments");
    vi.useRealTimers();
  });

  it("watch returns no CTA on timeout", async () => {
    const c = makeCtx({ watch: true, interval: 0.001, timeout: 0 });
    mockResolvePR.mockResolvedValue({ prNumber: 1, prUrl: "url" });
    setupCommentMocks();

    await reviewsCommand.run(c);
    const meta = c.ok.mock.calls[0][1];
    expect(meta.cta).toBeUndefined();
  });
});
