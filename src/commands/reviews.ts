import { z } from "zod";
import { type Context } from "../context.js";
import {
  fetchPRComments,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
  type ProcessedComment,
  type ProxyFetch,
} from "../github/index.js";

export const replySchema = z.object({
  id: z.number().describe("Reply ID"),
  user: z.string().describe("Author login"),
  body: z.string().describe("Reply body (cleaned)"),
  createdAt: z.string().describe("ISO timestamp"),
  isBot: z.boolean().describe("Whether author is a bot"),
});

export const commentSchema = z.object({
  id: z.number().describe("Comment ID (use with --detail or --reply)"),
  type: z
    .enum(["review_comment", "issue_comment", "review"])
    .describe("CODE = inline, COMMENT = PR-level, REVIEW = review summary"),
  user: z.string().describe("Author login"),
  isBot: z.boolean().describe("Whether author is a bot"),
  path: z.string().nullable().describe("File path (inline comments only)"),
  line: z.number().nullable().describe("Line number (inline comments only)"),
  diffHunk: z.string().nullable().describe("Surrounding diff context"),
  body: z.string().describe("Comment body (cleaned of bot boilerplate)"),
  createdAt: z.string().describe("ISO timestamp"),
  updatedAt: z.string().describe("ISO timestamp of last update"),
  url: z.string().describe("GitHub URL"),
  replies: z.array(replySchema).describe("Thread replies"),
  hasHumanReply: z.boolean().describe("Whether a human has replied"),
  hasAnyReply: z.boolean().describe("Whether any reply exists"),
  isResolved: z.boolean().describe("Whether the thread is resolved"),
});

// ---------------------------------------------------------------------------
// Pure logic functions
// ---------------------------------------------------------------------------

export async function getReviewsList(
  ctx: Context,
  prNumber: number,
  filterOpts: {
    unresolved: boolean;
    unanswered: boolean;
    botsOnly: boolean;
    humansOnly: boolean;
  },
): Promise<{ comments: ProcessedComment[]; total: number }> {
  const { token, repoInfo, proxyFetch } = ctx;

  const rawData = await fetchPRComments(repoInfo.owner, repoInfo.repo, prNumber, token, proxyFetch);
  const processed = processComments(rawData);
  const filtered = filterComments(processed, {
    botsOnly: filterOpts.botsOnly,
    humansOnly: filterOpts.humansOnly,
    filter: filterOpts.unresolved ? "unresolved" : filterOpts.unanswered ? "unanswered" : null,
  });

  return { comments: filtered, total: filtered.length };
}

export async function getReviewDetail(
  ctx: Context,
  prNumber: number,
  commentId: number,
): Promise<ProcessedComment | undefined> {
  const { token, repoInfo, proxyFetch } = ctx;

  const rawData = await fetchPRComments(repoInfo.owner, repoInfo.repo, prNumber, token, proxyFetch);
  const processed = processComments(rawData);
  return processed.find((cm) => cm.id === commentId);
}

export async function postReply(
  ctx: Context,
  prNumber: number,
  replyStr: string,
  shouldResolve: boolean,
): Promise<{
  replied: boolean;
  commentId: number;
  message: string;
  url: string;
  resolved?: boolean;
  resolveError?: string;
}> {
  const { token, repoInfo, proxyFetch } = ctx;

  const colonIdx = replyStr.indexOf(":");
  if (colonIdx === -1) {
    throw new Error("--reply format is <id>:<message>");
  }
  const commentId = Number(replyStr.slice(0, colonIdx));
  const message = replyStr.slice(colonIdx + 1);

  const result = await replyToComment(
    repoInfo.owner,
    repoInfo.repo,
    prNumber,
    commentId,
    message,
    token,
    proxyFetch,
  );

  let resolved: boolean | undefined;
  let resolveError: string | undefined;
  if (shouldResolve) {
    try {
      const res = await resolveThread(
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        commentId,
        token,
        proxyFetch,
      );
      resolved = "resolved" in res && res.resolved;
    } catch (error: any) {
      resolved = false;
      resolveError = error?.message ?? "Failed to resolve thread";
    }
  }

  return { replied: true, commentId, message, url: result.html_url, resolved, resolveError };
}

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

export function formatReviewsSection(
  comments: ProcessedComment[],
): Record<string, string | number> {
  const unresolvedCount = comments.filter((c) => !(c.isResolved || c.hasHumanReply)).length;
  const unansweredCount = comments.filter((c) => !c.hasAnyReply).length;

  const result: Record<string, string | number> = {
    total: `${unresolvedCount} unresolved, ${unansweredCount} unanswered`,
  };

  for (const comment of comments) {
    const location = comment.path
      ? `${comment.path}${comment.line ? `:${comment.line}` : ""}`
      : null;
    const key = location ? `REVIEW ${comment.id} ${location}` : `REVIEW ${comment.id}`;

    const body = comment.body;

    result[key] = body;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Watch helper
// ---------------------------------------------------------------------------

export async function watchForComments(
  context: {
    owner: string;
    repo: string;
    prNumber: number;
    token: string;
    proxyFetch: ProxyFetch;
  },
  options: {
    botsOnly?: boolean;
    humansOnly?: boolean;
    filter?: "unresolved" | "unanswered" | null;
    watchInterval: number;
    watchTimeout: number;
  },
) {
  const { owner, repo, prNumber, token, proxyFetch } = context;
  const seenIds = new Set<number>();
  const startTime = Date.now();

  const initialData = await fetchPRComments(owner, repo, prNumber, token, proxyFetch);
  const initialProcessed = processComments(initialData);
  const initialFiltered = filterComments(initialProcessed, options);
  for (const comment of initialFiltered) {
    seenIds.add(comment.id);
  }

  while (true) {
    await new Promise<void>((r) => setTimeout(r, options.watchInterval * 1000));

    const rawData = await fetchPRComments(owner, repo, prNumber, token, proxyFetch);
    const processed = processComments(rawData);
    const filtered = filterComments(processed, options);
    const newComments = filtered.filter((cm) => !seenIds.has(cm.id));

    if (newComments.length > 0) {
      for (const cm of newComments) {
        seenIds.add(cm.id);
      }

      // Grace period for bot batches
      await new Promise<void>((r) => setTimeout(r, 5_000));
      const graceData = await fetchPRComments(owner, repo, prNumber, token, proxyFetch);
      const graceProcessed = processComments(graceData);
      const graceFiltered = filterComments(graceProcessed, options);
      for (const cm of graceFiltered) {
        if (!seenIds.has(cm.id)) {
          seenIds.add(cm.id);
          newComments.push(cm);
        }
      }

      return { newComments, total: newComments.length, timedOut: false };
    }

    if (Math.round((Date.now() - startTime) / 1000) >= options.watchTimeout) {
      return { newComments: [], total: 0, timedOut: true };
    }
  }
}
