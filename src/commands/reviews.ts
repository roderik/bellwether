import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import {
  type ProxyFetch,
  fetchPRComments,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
} from "../github/index.js";

const replySchema = z.object({
  id: z.number().describe("Reply ID"),
  user: z.string().describe("Author login"),
  body: z.string().describe("Reply body (cleaned)"),
  createdAt: z.string().describe("ISO timestamp"),
  isBot: z.boolean().describe("Whether author is a bot"),
});

const commentSchema = z.object({
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

export const reviewsCommand = {
  description: "List, filter, reply to, and watch PR review comments",
  hint: "Comment IDs shown in output can be used with --detail and --reply. Bot meta-comments (Vercel deploy status, CodeRabbit summaries, etc.) are automatically filtered out.",
  args: z.object({
    pr: z.coerce
      .number()
      .optional()
      .describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    unresolved: z
      .boolean()
      .default(false)
      .describe("Show only unresolved/pending comments"),
    unanswered: z
      .boolean()
      .default(false)
      .describe("Show only comments without any replies"),
    botsOnly: z
      .boolean()
      .default(false)
      .describe("Only show comments from bots"),
    humansOnly: z
      .boolean()
      .default(false)
      .describe("Only show comments from humans"),
    reply: z
      .string()
      .optional()
      .describe("Reply to a comment: <id>:<message>"),
    resolve: z
      .boolean()
      .default(false)
      .describe("Resolve the thread after replying"),
    detail: z.coerce
      .number()
      .optional()
      .describe("Show full detail for a specific comment ID"),
    watch: z
      .boolean()
      .default(false)
      .describe("Poll for new comments (exits on detection)"),
    interval: z.coerce
      .number()
      .default(30)
      .describe("Poll interval in seconds (watch mode)"),
    timeout: z.coerce
      .number()
      .default(600)
      .describe("Inactivity timeout in seconds (watch mode)"),
  }),
  alias: {
    unresolved: "u",
    unanswered: "a",
    botsOnly: "b",
    humansOnly: "H",
    reply: "r",
    detail: "d",
    watch: "w",
    interval: "i",
  },
  usage: [
    {},
    { args: { pr: true } },
    { args: { pr: true }, options: { unresolved: true, botsOnly: true } },
    { args: { pr: true }, options: { detail: true } },
    { args: { pr: true }, options: { reply: true } },
    { args: { pr: true }, options: { reply: true, resolve: true } },
    { args: { pr: true }, options: { watch: true } },
  ],
  output: z.object({
    comments: z.array(commentSchema).optional().describe("List of comments (list mode)"),
    comment: commentSchema.optional().describe("Single comment (detail mode)"),
    replied: z.boolean().optional().describe("Whether reply was posted (reply mode)"),
    commentId: z.number().optional().describe("ID of comment replied to (reply mode)"),
    url: z.string().optional().describe("URL of posted reply (reply mode)"),
    resolved: z.boolean().optional().describe("Whether thread was resolved (reply mode)"),
    newComments: z.array(commentSchema).optional().describe("Newly detected comments (watch mode)"),
    total: z.number().optional().describe("Count of returned comments"),
    timedOut: z.boolean().optional().describe("Whether watch timed out without new comments"),
  }),
  examples: [
    { description: "List all comments for current branch's PR" },
    { args: { pr: 42 }, description: "List comments for PR #42" },
    {
      options: { unresolved: true, botsOnly: true },
      description: "Unresolved bot comments",
    },
    {
      options: { detail: 12345 },
      description: "Full detail for comment #12345",
    },
    {
      options: { reply: "12345:Fixed in latest commit" },
      description: "Reply to comment #12345",
    },
    {
      options: { reply: "12345:Addressed", resolve: true },
      description: "Reply and resolve thread",
    },
    {
      options: { watch: true, botsOnly: true, interval: 15 },
      description: "Watch for new bot comments, poll every 15s",
    },
  ],
  async run(c: any) {
    const ctx: Context = c.var.ctx;
    const { prNumber } = await resolvePR(ctx, c.args.pr);
    const { token, repoInfo, proxyFetch } = ctx;
    const opts = c.options;

    const filterOpts = {
      botsOnly: opts.botsOnly,
      humansOnly: opts.humansOnly,
      filter: opts.unresolved
        ? ("unresolved" as const)
        : opts.unanswered
          ? ("unanswered" as const)
          : null,
    };

    // Reply
    if (opts.reply) {
      const colonIdx = opts.reply.indexOf(":");
      if (colonIdx === -1) {
        return c.error({
          code: "INVALID_ARGS",
          message: "--reply format is <id>:<message>",
          retryable: true,
          cta: {
            description: "Correct usage:",
            commands: [
              {
                command: "reviews",
                args: { pr: prNumber },
                options: { reply: "12345:your message here" },
                description: "Reply with id:message format",
              },
            ],
          },
        });
      }
      const commentId = Number(opts.reply.slice(0, colonIdx));
      const message = opts.reply.slice(colonIdx + 1);

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
      if (opts.resolve) {
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
        } catch {
          resolved = false;
        }
      }

      return c.ok(
        { replied: true, commentId, url: result.html_url, resolved },
        {
          cta: {
            description: "Next:",
            commands: [
              {
                command: "reviews",
                args: { pr: prNumber },
                options: { detail: commentId },
                description: "View updated comment",
              },
              {
                command: "reviews",
                args: { pr: prNumber },
                description: "List all comments",
              },
            ],
          },
        },
      );
    }

    // Detail
    if (opts.detail) {
      const rawData = await fetchPRComments(
        repoInfo.owner,
        repoInfo.repo,
        prNumber,
        token,
        proxyFetch,
      );
      const processed = processComments(rawData);
      const comment = processed.find((cm) => cm.id === opts.detail);
      if (!comment) {
        return c.error({
          code: "NOT_FOUND",
          message: `Comment ${opts.detail} not found in PR #${prNumber}`,
          retryable: false,
          cta: {
            description: "Try:",
            commands: [
              {
                command: "reviews",
                args: { pr: prNumber },
                description: "List all comments to find valid IDs",
              },
            ],
          },
        });
      }
      return c.ok(
        { comment },
        {
          cta: {
            description: "Actions:",
            commands: [
              {
                command: "reviews",
                args: { pr: prNumber },
                options: { reply: `${comment.id}:your message` },
                description: "Reply to this comment",
              },
              {
                command: "reviews",
                args: { pr: prNumber },
                options: { reply: `${comment.id}:Addressed`, resolve: true },
                description: "Reply and resolve",
              },
            ],
          },
        },
      );
    }

    // Watch
    if (opts.watch) {
      const result = await watchForComments(
        { owner: repoInfo.owner, repo: repoInfo.repo, prNumber, token, proxyFetch },
        { ...filterOpts, watchInterval: opts.interval, watchTimeout: opts.timeout },
      );
      return c.ok(result, {
        cta:
          result.total > 0
            ? {
                description: "Process new comments:",
                commands: [
                  {
                    command: "reviews",
                    args: { pr: prNumber },
                    options: { unresolved: true },
                    description: "List unresolved comments",
                  },
                ],
              }
            : undefined,
      });
    }

    // List (default)
    const rawData = await fetchPRComments(
      repoInfo.owner,
      repoInfo.repo,
      prNumber,
      token,
      proxyFetch,
    );
    const processed = processComments(rawData);
    const filtered = filterComments(processed, filterOpts);

    return c.ok(
      { comments: filtered, total: filtered.length },
      filtered.length > 0
        ? {
            cta: {
              description: "Actions:",
              commands: [
                {
                  command: "reviews",
                  args: { pr: prNumber },
                  options: { detail: filtered[0]!.id },
                  description: "View first comment detail",
                },
                {
                  command: "reviews",
                  args: { pr: prNumber },
                  options: { watch: true },
                  description: "Watch for new comments",
                },
              ],
            },
          }
        : undefined,
    );
  },
};

// ---------------------------------------------------------------------------
// Watch helper
// ---------------------------------------------------------------------------

async function watchForComments(
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
  for (const comment of initialFiltered) seenIds.add(comment.id);

  while (true) {
    await new Promise<void>((r) => setTimeout(r, options.watchInterval * 1000));

    const rawData = await fetchPRComments(owner, repo, prNumber, token, proxyFetch);
    const processed = processComments(rawData);
    const filtered = filterComments(processed, options);
    const newComments = filtered.filter((cm) => !seenIds.has(cm.id));

    if (newComments.length > 0) {
      for (const cm of newComments) seenIds.add(cm.id);

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
