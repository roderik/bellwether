import { describe, it, expect, vi } from "vitest";
import {
  processComments,
  filterComments,
  fetchPRComments,
  fetchThreadResolutionState,
  replyToComment,
  resolveThread,
  TRACKING_COMMENT_MARKER,
  type ProcessedComment,
} from "../../src/github/comments.js";
import { type GitHubClient } from "../../src/github/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReviewComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: { login: "alice" },
    body: "Looks good",
    path: "src/foo.ts",
    line: 10,
    original_line: null,
    diff_hunk: "@@ -1,3 +1,3 @@",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    html_url: "https://github.com/o/r/pull/1#comment-1",
    in_reply_to_id: undefined,
    ...overrides,
  };
}

function makeIssueComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    user: { login: "bob" },
    body: "Nice PR",
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    html_url: "https://github.com/o/r/pull/1#issuecomment-100",
    ...overrides,
  };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    user: { login: "carol" },
    body: "Approved",
    state: "APPROVED",
    submitted_at: "2024-01-03T00:00:00Z",
    html_url: "https://github.com/o/r/pull/1#pullrequestreview-200",
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------------
// processComments
// ---------------------------------------------------------------------------

describe("processComments", () => {
  it("processes review comments", () => {
    const result = processComments({
      reviewComments: [makeReviewComment()],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("review_comment");
    expect(result[0].user).toBe("alice");
    expect(result[0].path).toBe("src/foo.ts");
    expect(result[0].line).toBe(10);
    expect(result[0].isBot).toBe(false);
    expect(result[0].isResolved).toBe(false);
  });

  it("uses original_line when line is falsy", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ line: 0, original_line: 42 })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].line).toBe(42);
  });

  it("builds reply map and attaches replies to parent", () => {
    const parent = makeReviewComment({ id: 1 });
    const reply = makeReviewComment({
      id: 2,
      in_reply_to_id: 1,
      user: { login: "dave" },
      body: "Fixed",
    });
    const result = processComments({
      reviewComments: [parent, reply],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].replies).toHaveLength(1);
    expect(result[0].replies[0].user).toBe("dave");
    expect(result[0].hasAnyReply).toBe(true);
    expect(result[0].hasHumanReply).toBe(true);
  });

  it("detects bot replies", () => {
    const parent = makeReviewComment({ id: 1 });
    const botReply = makeReviewComment({
      id: 2,
      in_reply_to_id: 1,
      user: { login: "coderabbitai[bot]" },
    });
    const result = processComments({
      reviewComments: [parent, botReply],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].hasAnyReply).toBe(true);
    expect(result[0].hasHumanReply).toBe(false);
  });

  it("processes issue comments", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [makeIssueComment()],
      reviews: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("issue_comment");
    expect(result[0].path).toBeNull();
    expect(result[0].replies).toEqual([]);
    expect(result[0].hasAnyReply).toBe(false);
  });

  it("detects old-style reply to issue comment", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({ id: 100 }),
        makeIssueComment({ id: 101, body: "> Re: comment 100\n\nHandled" }),
      ],
      reviews: [],
    });
    // Only the original comment appears (reply is meta-filtered)
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(100);
    expect(result[0].hasAnyReply).toBe(true);
  });

  it("detects tracking comment reply to issue comment", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({ id: 100 }),
        makeIssueComment({ id: 200 }),
        makeIssueComment({
          id: 300,
          body: `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — Fixed\n- Re: comment 200 — Done`,
        }),
      ],
      reviews: [],
    });
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.id === 100)!.hasAnyReply).toBe(true);
    expect(result.find((c) => c.id === 200)!.hasAnyReply).toBe(true);
  });

  it("issue comment without reply has hasAnyReply false", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({ id: 100 }),
        makeIssueComment({ id: 101, body: "> Re: comment 999\n\nUnrelated" }),
      ],
      reviews: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(100);
    expect(result[0].hasAnyReply).toBe(false);
  });

  it("processes human reviews with body", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview()],
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("review");
    expect(result[0].isResolved).toBe(true); // APPROVED
    expect(result[0].state).toBe("APPROVED");
  });

  it("marks DISMISSED reviews as resolved", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ state: "DISMISSED" })],
    });
    expect(result[0].isResolved).toBe(true);
  });

  it("marks CHANGES_REQUESTED reviews as not resolved", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ state: "CHANGES_REQUESTED" })],
    });
    expect(result[0].isResolved).toBe(false);
  });

  it("skips bot reviews", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ user: { login: "coderabbitai[bot]" } })],
    });
    expect(result).toHaveLength(0);
  });

  it("skips reviews with empty body", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ body: "" })],
    });
    expect(result).toHaveLength(0);
  });

  it("skips reviews with whitespace-only body", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ body: "   " })],
    });
    expect(result).toHaveLength(0);
  });

  it("skips reviews with null body", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ body: null })],
    });
    expect(result).toHaveLength(0);
  });

  it("sorts by createdAt descending", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ id: 1, created_at: "2024-01-01T00:00:00Z" }),
        makeReviewComment({ id: 2, created_at: "2024-01-03T00:00:00Z" }),
      ],
      issueComments: [makeIssueComment({ id: 100, created_at: "2024-01-02T00:00:00Z" })],
      reviews: [],
    });
    expect(result.map((c) => c.id)).toEqual([2, 100, 1]);
  });

  // Meta-comment filtering
  it("filters vercel meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "vercel[bot]" }, body: "[vc]: some deploy status" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters vercel meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: "vercel" }, body: "[vc]: deploy" })],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters supabase meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "supabase[bot]" }, body: "[supa]: status" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters supabase meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: "supabase" }, body: "[supa]: status" })],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters cursor meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "cursor[bot]" },
          body: "Cursor Bugbot has reviewed your changes and found issues",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters cursor meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "cursor" },
          body: "Cursor Bugbot has reviewed your changes and found issues",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters copilot meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "copilot-pull-request-reviewer[bot]" },
          body: "Pull request overview summary",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters copilot meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "copilot-pull-request-reviewer" },
          body: "Pull request overview summary",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters coderabbitai meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "coderabbitai[bot]" },
          body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->Summary",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters coderabbitai meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "coderabbitai" },
          body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->Summary",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sourcery-ai meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "sourcery-ai[bot]" },
          body: "<!-- Generated by sourcery-ai[bot]: review -->",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sourcery-ai meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "sourcery-ai" },
          body: "<!-- Generated by sourcery-ai[bot]: review -->",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters codacy meta-comments (Analysis Summary)", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "codacy-production[bot]" },
          body: "Codacy's Analysis Summary report",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters codacy meta-comments (Coverage summary)", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "codacy-production" },
          body: "Coverage summary from Codacy for this PR",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarcloud meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "sonarcloud[bot]" }, body: "Quality Gate passed" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarcloud meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "sonarcloud" }, body: "Quality Gate passed" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarqubecloud meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "sonarqubecloud[bot]" }, body: "Quality Gate failed" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarqubecloud non-bot meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "sonarqubecloud" }, body: "Quality Gate failed" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarqube-cloud-us meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          user: { login: "sonarqube-cloud-us[bot]" },
          body: "Quality Gate passed",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters sonarqube-cloud-us non-bot meta-comments", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ user: { login: "sonarqube-cloud-us" }, body: "Quality Gate passed" }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters re-quote meta-comments", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ body: "> Re: comment 123\n\nHere's my reply" })],
      issueComments: [],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters tracking comment meta-comments", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({
          body: `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — Fixed`,
        }),
      ],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("also filters meta-comments from issue comments", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [makeIssueComment({ user: { login: "vercel[bot]" }, body: "[vc]: deploy" })],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("also filters meta-comments from reviews", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [],
      reviews: [makeReview({ user: { login: "alice" }, body: "> Re: comment 456\nReply" })],
    });
    expect(result).toHaveLength(0);
  });

  it("does not filter comments with empty body as meta", () => {
    // isMetaComment returns false when body is empty/falsy
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: "vercel[bot]" }, body: "" })],
      issueComments: [],
      reviews: [],
    });
    // body is empty but it's not a meta-comment, so it passes — though cleanBody returns ""
    expect(result).toHaveLength(1);
  });

  // Body cleanup
  it("strips HTML comments from body", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ body: "before<!-- hidden -->after" })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).toBe("beforeafter");
  });

  it("strips Additional Locations details blocks", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({
          body: "issue\n<details>\n<summary>\nAdditional Locations\n</summary>\nstuff\n</details>\nmore",
        }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).not.toContain("Additional Locations");
    expect(result[0].body).toContain("issue");
    expect(result[0].body).toContain("more");
  });

  it("strips cursor.com p blocks", () => {
    const result = processComments({
      reviewComments: [
        makeReviewComment({ body: 'text<p>\n<a href="https://cursor.com/link">link</a>\n</p>end' }),
      ],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).not.toContain("cursor.com");
  });

  it("collapses 3+ newlines to 2", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ body: "a\n\n\n\nb" })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).toBe("a\n\nb");
  });

  it("returns empty string for null body", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ body: null })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).toBe("");
  });

  it("returns empty string for undefined body", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ body: undefined })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].body).toBe("");
  });

  // Bot detection
  it("detects [bot] suffix", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: "dependabot[bot]" } })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].isBot).toBe(true);
  });

  it("detects known bot logins", () => {
    for (const login of [
      "cursor",
      "vercel",
      "supabase",
      "github-actions",
      "Copilot",
      "coderabbitai",
      "sourcery-ai",
      "codacy-production",
      "sonarcloud",
      "sonarqubecloud",
      "sonarqube-cloud-us",
      "chatgpt-codex-connector",
      "copilot-pull-request-reviewer",
    ]) {
      const result = processComments({
        reviewComments: [makeReviewComment({ user: { login } })],
        issueComments: [],
        reviews: [],
      });
      expect(result[0].isBot).toBe(true);
    }
  });

  it("detects bot via includes('bot')", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: "mybot-helper" } })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].isBot).toBe(true);
  });

  it("treats undefined user as not bot", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ user: { login: undefined } })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].isBot).toBe(false);
  });

  it("handles null diff_hunk", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ diff_hunk: null })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].diffHunk).toBeNull();
  });

  it("filters pkg-pr-new meta-comments", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({
          user: { login: "pkg-pr-new[bot]" },
          body: "Published via pkg.pr.new\nhttps://pkg.pr.new/bellwether@123",
        }),
      ],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });

  it("filters pkg-pr-new meta-comments from non-bot login", () => {
    const result = processComments({
      reviewComments: [],
      issueComments: [
        makeIssueComment({
          user: { login: "pkg-pr-new" },
          body: "Published via pkg.pr.new\nhttps://pkg.pr.new/bellwether@123",
        }),
      ],
      reviews: [],
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fetchThreadResolutionState
// ---------------------------------------------------------------------------

describe("fetchThreadResolutionState", () => {
  it("maps databaseId to isResolved for a single page of threads", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { id: "T1", isResolved: true, comments: { nodes: [{ databaseId: 10 }] } },
              { id: "T2", isResolved: false, comments: { nodes: [{ databaseId: 20 }] } },
            ],
          },
        },
      },
    });

    const result = await fetchThreadResolutionState("o", "r", 1, octokit);
    expect(result.get(10)).toBe(true);
    expect(result.get(20)).toBe(false);
    expect(result.size).toBe(2);
  });

  it("paginates when hasNextPage is true", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql)
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "cursor1" },
              nodes: [{ id: "T1", isResolved: true, comments: { nodes: [{ databaseId: 10 }] } }],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "T2", isResolved: false, comments: { nodes: [{ databaseId: 20 }] } }],
            },
          },
        },
      });

    const result = await fetchThreadResolutionState("o", "r", 1, octokit);
    expect(result.get(10)).toBe(true);
    expect(result.get(20)).toBe(false);
    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    // Verify second call used cursor from first page
    expect(octokit.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cursor: "cursor1" }),
    );
  });

  it("returns empty map when reviewThreads is missing", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockResolvedValueOnce({
      repository: { pullRequest: {} },
    });

    const result = await fetchThreadResolutionState("o", "r", 1, octokit);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processComments: threadResolutionState and staleSha
// ---------------------------------------------------------------------------

describe("processComments thread resolution and staleness", () => {
  it("uses threadResolutionState to set isResolved on review comments", () => {
    const threadState = new Map<number, boolean>([[1, true]]);

    const result = processComments({
      reviewComments: [makeReviewComment({ id: 1 })],
      issueComments: [],
      reviews: [],
      threadResolutionState: threadState,
    });
    expect(result[0].isResolved).toBe(true);
  });

  it("sets staleSha when headSha differs from commit_id", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ id: 1, commit_id: "def456" })],
      issueComments: [],
      reviews: [],
      headSha: "abc123",
    });
    expect(result[0].staleSha).toBe("def456");
  });

  it("does not set staleSha when commit_id matches headSha", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ id: 1, commit_id: "abc123" })],
      issueComments: [],
      reviews: [],
      headSha: "abc123",
    });
    expect(result[0].staleSha).toBeUndefined();
  });

  it("does not set staleSha when headSha is not provided", () => {
    const result = processComments({
      reviewComments: [makeReviewComment({ id: 1, commit_id: "def456" })],
      issueComments: [],
      reviews: [],
    });
    expect(result[0].staleSha).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filterComments
// ---------------------------------------------------------------------------

describe("filterComments", () => {
  const comments = [
    { id: 1, isBot: true, isResolved: false, hasHumanReply: false, hasAnyReply: false },
    { id: 2, isBot: false, isResolved: true, hasHumanReply: true, hasAnyReply: true },
    { id: 3, isBot: false, isResolved: false, hasHumanReply: false, hasAnyReply: true },
    { id: 4, isBot: false, isResolved: false, hasHumanReply: false, hasAnyReply: false },
  ] as unknown as ProcessedComment[];

  it("returns all with no filters", () => {
    expect(filterComments(comments, {})).toHaveLength(4);
  });

  it("filters botsOnly", () => {
    const result = filterComments(comments, { botsOnly: true });
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("filters humansOnly", () => {
    const result = filterComments(comments, { humansOnly: true });
    expect(result.map((c) => c.id)).toEqual([2, 3, 4]);
  });

  it("filters unresolved (not resolved and no human reply)", () => {
    const result = filterComments(comments, { filter: "unresolved" });
    expect(result.map((c) => c.id)).toEqual([1, 3, 4]);
  });

  it("filters unanswered (no replies at all)", () => {
    const result = filterComments(comments, { filter: "unanswered" });
    expect(result.map((c) => c.id)).toEqual([1, 4]);
  });

  it("combines botsOnly + unresolved", () => {
    const result = filterComments(comments, { botsOnly: true, filter: "unresolved" });
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("handles null filter", () => {
    const result = filterComments(comments, { filter: null });
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// fetchPRComments
// ---------------------------------------------------------------------------

describe("fetchPRComments", () => {
  it("fetches review comments, issue comments, reviews, and thread resolution in parallel", async () => {
    const octokit = createMockOctokit();
    // paginate is called 3 times in parallel for review comments, issue comments, and reviews
    vi.mocked(octokit.paginate)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }])
      .mockResolvedValueOnce([{ id: 3 }]);
    // graphql is called for thread resolution state
    vi.mocked(octokit.graphql).mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });

    const result = await fetchPRComments("owner", "repo", 1, octokit);
    expect(result.reviewComments).toEqual([{ id: 1 }]);
    expect(result.issueComments).toEqual([{ id: 2 }]);
    expect(result.reviews).toEqual([{ id: 3 }]);
    expect(result.threadResolutionState).toBeInstanceOf(Map);
    expect(octokit.paginate).toHaveBeenCalledTimes(3);
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// replyToComment
// ---------------------------------------------------------------------------

describe("replyToComment", () => {
  it("uses review comment reply endpoint when ok", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockResolvedValue({
      data: { html_url: "https://url" },
      status: 201,
      headers: {},
      url: "",
    } as never);
    const result = await replyToComment("o", "r", 1, 123, "msg", octokit);
    expect(result.html_url).toBe("https://url");
  });

  it("creates new tracking comment when no existing one found", async () => {
    const octokit = createMockOctokit();
    // review reply fails with 404
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 404,
      message: "Not Found",
    });
    // paginate returns empty issue comments
    vi.mocked(octokit.paginate).mockResolvedValue([]);
    // create new tracking comment
    vi.mocked(octokit.rest.issues.createComment).mockResolvedValue({
      data: { html_url: "https://tracking-new" },
      status: 201,
      headers: {},
      url: "",
    } as never);

    const result = await replyToComment("o", "r", 1, 123, "msg", octokit);
    expect(result.html_url).toBe("https://tracking-new");
    // Verify the body contains the tracking marker
    const createCall = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0];
    expect(createCall!.body).toContain(TRACKING_COMMENT_MARKER);
    expect(createCall!.body).toContain("- Re: comment 123");
  });

  it("updates existing tracking comment with re-fetch and new bullet", async () => {
    const existingBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — First`;
    const octokit = createMockOctokit();
    // review reply fails with 404
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 404,
      message: "Not Found",
    });
    // paginate returns existing tracking comment
    vi.mocked(octokit.paginate).mockResolvedValue([
      { id: 50, body: existingBody, updated_at: "2024-01-01T00:00:00Z" },
    ]);
    // re-fetch fresh body
    vi.mocked(octokit.rest.issues.getComment).mockResolvedValue({
      data: { id: 50, body: existingBody },
      status: 200,
      headers: {},
      url: "",
    } as never);
    // PATCH tracking comment
    vi.mocked(octokit.rest.issues.updateComment).mockResolvedValue({
      data: { html_url: "https://tracking-updated" },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await replyToComment("o", "r", 1, 123, "msg", octokit);
    expect(result.html_url).toBe("https://tracking-updated");
    // Verify the PATCH body appends the new bullet
    const updateCall = vi.mocked(octokit.rest.issues.updateComment).mock.calls[0]?.[0];
    expect(updateCall!.body).toContain("- Re: comment 100 — First");
    expect(updateCall!.body).toContain("- Re: comment 123 — msg");
  });

  it("falls back to stale body when getComment fails", async () => {
    const existingBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — First`;
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 404,
      message: "Not Found",
    });
    vi.mocked(octokit.paginate).mockResolvedValue([
      { id: 50, body: existingBody, updated_at: "2024-01-01T00:00:00Z" },
    ]);
    // getComment fails (e.g., rate limited)
    vi.mocked(octokit.rest.issues.getComment).mockRejectedValue(new Error("rate limited"));
    // PATCH with stale body
    vi.mocked(octokit.rest.issues.updateComment).mockResolvedValue({
      data: { html_url: "https://fallback" },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await replyToComment("o", "r", 1, 123, "msg", octokit);
    expect(result.html_url).toBe("https://fallback");
    const updateCall = vi.mocked(octokit.rest.issues.updateComment).mock.calls[0]?.[0];
    expect(updateCall!.body).toContain("- Re: comment 100 — First");
    expect(updateCall!.body).toContain("- Re: comment 123 — msg");
  });

  it("picks most recently updated tracking comment", async () => {
    const oldBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 50 — Old`;
    const newBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — New`;
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 404,
      message: "Not Found",
    });
    vi.mocked(octokit.paginate).mockResolvedValue([
      { id: 10, body: oldBody, updated_at: "2024-01-01T00:00:00Z" },
      { id: 20, body: newBody, updated_at: "2024-01-02T00:00:00Z" },
    ]);
    // re-fetch fresh body for id=20 (most recent)
    vi.mocked(octokit.rest.issues.getComment).mockResolvedValue({
      data: { id: 20, body: newBody },
      status: 200,
      headers: {},
      url: "",
    } as never);
    // PATCH
    vi.mocked(octokit.rest.issues.updateComment).mockResolvedValue({
      data: { html_url: "https://url" },
      status: 200,
      headers: {},
      url: "",
    } as never);

    const result = await replyToComment("o", "r", 1, 123, "msg", octokit);
    expect(result.html_url).toBe("https://url");
    // Verify PATCH went to comment 20, not 10
    const updateCall = vi.mocked(octokit.rest.issues.updateComment).mock.calls[0]?.[0];
    expect(updateCall!.comment_id).toBe(20);
  });

  it("throws on non-404 review reply failure", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 500,
      message: "Server Error",
    });
    await expect(replyToComment("o", "r", 1, 123, "msg", octokit)).rejects.toEqual({
      status: 500,
      message: "Server Error",
    });
  });

  it("throws on auth failure without fallback", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.rest.pulls.createReplyForReviewComment).mockRejectedValue({
      status: 401,
      message: "Unauthorized",
    });
    await expect(replyToComment("o", "r", 1, 123, "msg", octokit)).rejects.toEqual({
      status: 401,
      message: "Unauthorized",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveThread
// ---------------------------------------------------------------------------

describe("resolveThread", () => {
  it("returns skipped when thread not found", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });
    const result = await resolveThread("o", "r", 1, 999, octokit);
    expect(result).toEqual({ skipped: true, reason: "not a review comment thread" });
  });

  it("returns alreadyResolved when thread is resolved", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "T1", isResolved: true, comments: { nodes: [{ databaseId: 123 }] } }],
          },
        },
      },
    });
    const result = await resolveThread("o", "r", 1, 123, octokit);
    expect(result).toEqual({ alreadyResolved: true, threadId: "T1" });
  });

  it("resolves thread via mutation", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql)
      // First call: query to find the thread
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } }],
            },
          },
        },
      })
      // Second call: mutation to resolve
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { id: "T1", isResolved: true } },
      });

    const result = await resolveThread("o", "r", 1, 123, octokit);
    expect(result).toEqual({ resolved: true, threadId: "T1" });
  });

  it("paginates to find thread", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql)
      // First page: thread not found, has next page
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [{ id: "T0", isResolved: false, comments: { nodes: [{ databaseId: 999 }] } }],
            },
          },
        },
      })
      // Second page: thread found
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } }],
            },
          },
        },
      })
      // Mutation to resolve
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { id: "T1", isResolved: true } },
      });

    const result = await resolveThread("o", "r", 1, 123, octokit);
    expect(result).toEqual({ resolved: true, threadId: "T1" });
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
  });

  it("throws on GraphQL query failure", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockRejectedValue(new Error("GraphQL error"));
    await expect(resolveThread("o", "r", 1, 123, octokit)).rejects.toThrow("GraphQL error");
  });

  it("returns skipped when reviewThreads is null", async () => {
    const octokit = createMockOctokit();
    vi.mocked(octokit.graphql).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: null } },
    });
    const result = await resolveThread("o", "r", 1, 123, octokit);
    expect(result).toEqual({ skipped: true, reason: "not a review comment thread" });
  });
});
