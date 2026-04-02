import { describe, it, expect, vi } from "vitest";
import {
  processComments,
  filterComments,
  fetchPRComments,
  replyToComment,
  resolveThread,
  TRACKING_COMMENT_MARKER,
  type ProcessedComment,
} from "../../src/github/comments.js";

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

function mockProxyFetch(
  responses: { ok: boolean; status: number; data: unknown; headers?: Record<string, string> }[],
) {
  let callIdx = 0;
  return vi.fn(async () => {
    const resp = responses[callIdx++];
    return {
      ok: resp.ok,
      status: resp.status,
      headers: { get: (name: string) => resp.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(resp.data),
      json: async () => resp.data,
    };
  });
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
  it("fetches review comments, issue comments, and reviews in parallel", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: [{ id: 1 }], headers: { link: "" } },
      { ok: true, status: 200, data: [{ id: 2 }], headers: { link: "" } },
      { ok: true, status: 200, data: [{ id: 3 }], headers: { link: "" } },
    ]);
    const result = await fetchPRComments("owner", "repo", 1, "tok", pf);
    expect(result.reviewComments).toEqual([{ id: 1 }]);
    expect(result.issueComments).toEqual([{ id: 2 }]);
    expect(result.reviews).toEqual([{ id: 3 }]);
    expect(pf).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// replyToComment
// ---------------------------------------------------------------------------

describe("replyToComment", () => {
  it("uses review comment reply endpoint when ok", async () => {
    const pf = mockProxyFetch([{ ok: true, status: 201, data: { html_url: "https://url" } }]);
    const result = await replyToComment("o", "r", 1, 123, "msg", "tok", pf);
    expect(result.html_url).toBe("https://url");
  });

  it("creates new tracking comment when no existing one found", async () => {
    const pf = mockProxyFetch([
      // review reply fails
      { ok: false, status: 404, data: {} },
      // fetch existing issue comments (empty)
      { ok: true, status: 200, data: [], headers: { link: "" } },
      // create new tracking comment
      { ok: true, status: 201, data: { html_url: "https://tracking-new" } },
    ]);
    const result = await replyToComment("o", "r", 1, 123, "msg", "tok", pf);
    expect(result.html_url).toBe("https://tracking-new");
    // Verify the POST body contains the tracking marker
    // oxlint-disable-next-line typescript/no-explicit-any -- accessing mock internals
    const postArgs = (pf.mock.calls as any)[2][1];
    const body = JSON.parse(postArgs.body);
    expect(body.body).toContain(TRACKING_COMMENT_MARKER);
    expect(body.body).toContain("- Re: comment 123 — msg");
  });

  it("updates existing tracking comment with re-fetch and new bullet", async () => {
    const existingBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — First`;
    const pf = mockProxyFetch([
      // review reply fails with 404
      { ok: false, status: 404, data: {} },
      // fetch existing issue comments (has tracking comment)
      {
        ok: true,
        status: 200,
        data: [{ id: 50, body: existingBody, updated_at: "2024-01-01T00:00:00Z" }],
        headers: { link: "" },
      },
      // re-fetch fresh body
      { ok: true, status: 200, data: { id: 50, body: existingBody } },
      // PATCH tracking comment
      { ok: true, status: 200, data: { html_url: "https://tracking-updated" } },
    ]);
    const result = await replyToComment("o", "r", 1, 123, "msg", "tok", pf);
    expect(result.html_url).toBe("https://tracking-updated");
    // Verify the PATCH body appends the new bullet
    // oxlint-disable-next-line typescript/no-explicit-any -- accessing mock internals
    const patchArgs = (pf.mock.calls as any)[3][1];
    const body = JSON.parse(patchArgs.body);
    expect(body.body).toContain("- Re: comment 100 — First");
    expect(body.body).toContain("- Re: comment 123 — msg");
  });

  it("picks most recently updated tracking comment", async () => {
    const oldBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 50 — Old`;
    const newBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — New`;
    const pf = mockProxyFetch([
      { ok: false, status: 404, data: {} },
      {
        ok: true,
        status: 200,
        data: [
          { id: 10, body: oldBody, updated_at: "2024-01-01T00:00:00Z" },
          { id: 20, body: newBody, updated_at: "2024-01-02T00:00:00Z" },
        ],
        headers: { link: "" },
      },
      // re-fetch fresh body for id=20 (most recent)
      { ok: true, status: 200, data: { id: 20, body: newBody } },
      // PATCH
      { ok: true, status: 200, data: { html_url: "https://url" } },
    ]);
    const result = await replyToComment("o", "r", 1, 123, "msg", "tok", pf);
    expect(result.html_url).toBe("https://url");
    // Verify PATCH went to comment 20, not 10
    // oxlint-disable-next-line typescript/no-explicit-any -- accessing mock internals
    const patchUrl = (pf.mock.calls as any)[3][0];
    expect(patchUrl).toContain("/issues/comments/20");
  });

  it("falls back to stale body when re-fetch fails", async () => {
    const existingBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — First`;
    const pf = mockProxyFetch([
      { ok: false, status: 404, data: {} },
      {
        ok: true,
        status: 200,
        data: [{ id: 50, body: existingBody, updated_at: "2024-01-01T00:00:00Z" }],
        headers: { link: "" },
      },
      // re-fetch fails
      { ok: false, status: 500, data: {} },
      // PATCH still works using stale body
      { ok: true, status: 200, data: { html_url: "https://url" } },
    ]);
    const result = await replyToComment("o", "r", 1, 123, "msg", "tok", pf);
    expect(result.html_url).toBe("https://url");
  });

  it("throws on non-404 review reply failure", async () => {
    const pf = mockProxyFetch([{ ok: false, status: 500, data: "server error" }]);
    await expect(replyToComment("o", "r", 1, 123, "msg", "tok", pf)).rejects.toThrow(
      "Failed to reply: 500",
    );
  });

  it("throws on auth failure without fallback", async () => {
    const pf = mockProxyFetch([{ ok: false, status: 401, data: "unauthorized" }]);
    await expect(replyToComment("o", "r", 1, 123, "msg", "tok", pf)).rejects.toThrow(
      "Failed to reply: 401",
    );
  });

  it("throws when tracking comment update fails", async () => {
    const existingBody = `${TRACKING_COMMENT_MARKER}\n**Handled comments:**\n- Re: comment 100 — First`;
    const pf = mockProxyFetch([
      { ok: false, status: 404, data: {} },
      {
        ok: true,
        status: 200,
        data: [{ id: 50, body: existingBody, updated_at: "2024-01-01T00:00:00Z" }],
        headers: { link: "" },
      },
      // re-fetch
      { ok: true, status: 200, data: { id: 50, body: existingBody } },
      { ok: false, status: 500, data: "server error" },
    ]);
    await expect(replyToComment("o", "r", 1, 123, "msg", "tok", pf)).rejects.toThrow(
      "Failed to update tracking comment: 500",
    );
  });

  it("throws when tracking comment creation fails", async () => {
    const pf = mockProxyFetch([
      { ok: false, status: 404, data: {} },
      { ok: true, status: 200, data: [], headers: { link: "" } },
      { ok: false, status: 500, data: "server error" },
    ]);
    await expect(replyToComment("o", "r", 1, 123, "msg", "tok", pf)).rejects.toThrow(
      "Failed to reply: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveThread
// ---------------------------------------------------------------------------

describe("resolveThread", () => {
  it("returns skipped when thread not found", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        },
      },
    ]);
    const result = await resolveThread("o", "r", 1, 999, "tok", pf);
    expect(result).toEqual({ skipped: true, reason: "not a review comment thread" });
  });

  it("returns alreadyResolved when thread is resolved", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T1", isResolved: true, comments: { nodes: [{ databaseId: 123 }] } },
                  ],
                },
              },
            },
          },
        },
      },
    ]);
    const result = await resolveThread("o", "r", 1, 123, "tok", pf);
    expect(result).toEqual({ alreadyResolved: true, threadId: "T1" });
  });

  it("resolves thread via mutation", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        data: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } },
      },
    ]);
    const result = await resolveThread("o", "r", 1, 123, "tok", pf);
    expect(result).toEqual({ resolved: true, threadId: "T1" });
  });

  it("paginates to find thread", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [
                    { id: "T0", isResolved: false, comments: { nodes: [{ databaseId: 999 }] } },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        data: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } },
      },
    ]);
    const result = await resolveThread("o", "r", 1, 123, "tok", pf);
    expect(result).toEqual({ resolved: true, threadId: "T1" });
    expect(pf).toHaveBeenCalledTimes(3);
  });

  it("throws on GraphQL query failure", async () => {
    const pf = mockProxyFetch([{ ok: false, status: 401, data: {} }]);
    await expect(resolveThread("o", "r", 1, 123, "tok", pf)).rejects.toThrow(
      "GraphQL query failed: 401",
    );
  });

  it("throws on GraphQL errors in query response", async () => {
    const pf = mockProxyFetch([
      { ok: true, status: 200, data: { errors: [{ message: "bad query" }] } },
    ]);
    await expect(resolveThread("o", "r", 1, 123, "tok", pf)).rejects.toThrow(
      "GraphQL error: bad query",
    );
  });

  it("throws on mutation failure", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } },
                  ],
                },
              },
            },
          },
        },
      },
      { ok: false, status: 500, data: {} },
    ]);
    await expect(resolveThread("o", "r", 1, 123, "tok", pf)).rejects.toThrow(
      "Failed to resolve thread: 500",
    );
  });

  it("throws on mutation GraphQL errors", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 123 }] } },
                  ],
                },
              },
            },
          },
        },
      },
      { ok: true, status: 200, data: { errors: [{ message: "mutation failed" }] } },
    ]);
    await expect(resolveThread("o", "r", 1, 123, "tok", pf)).rejects.toThrow(
      "GraphQL error: mutation failed",
    );
  });

  it("returns skipped when reviewThreads is null", async () => {
    const pf = mockProxyFetch([
      {
        ok: true,
        status: 200,
        data: { data: { repository: { pullRequest: { reviewThreads: null } } } },
      },
    ]);
    const result = await resolveThread("o", "r", 1, 123, "tok", pf);
    expect(result).toEqual({ skipped: true, reason: "not a review comment thread" });
  });
});
