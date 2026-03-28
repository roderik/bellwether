import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import { getCISection } from "./ci.js";
import {
  getReviewsList,
  getReviewDetail,
  postReply,
  formatReviewsSection,
  commentSchema,
} from "./reviews.js";

export const checkCommand = {
  description: "Show CI status and review comments for a PR",
  hint: "Combines CI checks and review comments. Use --reply and --detail for review actions. With --watch, polls until CI completes.",
  args: z.object({
    pr: z.coerce.number().optional().describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    watch: z.boolean().default(false).describe("Poll until CI completes"),
    interval: z.coerce.number().default(30).describe("Poll interval in seconds"),
    timeout: z.coerce.number().default(1800).describe("Timeout in seconds"),
    unresolved: z.boolean().default(false).describe("Show only unresolved comments"),
    unanswered: z.boolean().default(false).describe("Show only unanswered comments"),
    botsOnly: z.boolean().default(false).describe("Only bot comments"),
    humansOnly: z.boolean().default(false).describe("Only human comments"),
    reply: z.string().optional().describe("Reply to comment: <id>:<message>"),
    resolve: z.boolean().default(false).describe("Resolve thread after replying"),
    detail: z.coerce.number().optional().describe("Show full detail for comment ID"),
  }),
  alias: {
    watch: "w",
    interval: "i",
    unresolved: "u",
    unanswered: "a",
    botsOnly: "b",
    humansOnly: "H",
    reply: "r",
    detail: "d",
  },
  usage: [
    {},
    { args: { pr: true } },
    { options: { watch: true } },
    { options: { detail: true } },
    { options: { reply: true } },
    { options: { reply: true, resolve: true } },
  ],
  output: z.object({
    ci: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    reviews: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    comment: commentSchema.optional(),
    replied: z.boolean().optional(),
    commentId: z.number().optional(),
    message: z.string().optional(),
    url: z.string().optional(),
    resolved: z.boolean().optional(),
    allPassing: z.boolean().optional(),
    timedOut: z.boolean().optional(),
  }),
  examples: [
    { description: "CI status + review comments for current branch" },
    { options: { watch: true }, description: "Watch until CI completes" },
    { options: { unresolved: true }, description: "Show only unresolved reviews" },
    { options: { detail: 456 }, description: "Full detail for comment 456" },
    { options: { reply: "456:Fixed in latest commit" }, description: "Reply to comment" },
    { options: { reply: "456:Done", resolve: true }, description: "Reply and resolve" },
  ],
  async run(c: any) {
    const ctx: Context = c.var.ctx;
    const { prNumber, headSha } = await resolvePR(ctx, c.args.pr);
    const opts = c.options;

    // Reply mode — no CI fetch needed
    if (opts.reply) {
      const result = await postReply(ctx, prNumber, opts.reply, opts.resolve);
      return c.ok(result);
    }

    // Detail mode — no CI fetch needed
    if (opts.detail) {
      const comment = await getReviewDetail(ctx, prNumber, opts.detail);
      if (!comment) {
        return c.error({ message: `Comment ${opts.detail} not found` });
      }
      return c.ok({ comment });
    }

    const filterOpts = {
      unresolved: opts.unresolved,
      unanswered: opts.unanswered,
      botsOnly: opts.botsOnly,
      humansOnly: opts.humansOnly,
    };

    // Watch mode — poll until CI terminal
    if (opts.watch) {
      const start = Date.now();
      while (true) {
        const [{ status, flat: ciFlat }, reviewData] = await Promise.all([
          getCISection(ctx, prNumber, headSha),
          getReviewsList(ctx, prNumber, filterOpts),
        ]);

        const reviewsFlat = formatReviewsSection(reviewData.comments);

        if (status.failing === 0 && status.pending === 0) {
          return c.ok({
            ci: { ...ciFlat, allPassing: true },
            reviews: reviewsFlat,
          });
        }

        if (status.failing > 0 && status.pending === 0) {
          return c.ok(
            {
              ci: { ...ciFlat, allPassing: false },
              reviews: reviewsFlat,
            },
            {
              cta: {
                description: "Failed checks detected:",
                commands: [
                  { command: "check --unresolved", description: "Show unresolved reviews" },
                ],
              },
            },
          );
        }

        if ((Date.now() - start) / 1000 >= opts.timeout) {
          return c.ok(
            {
              ci: { ...ciFlat, timedOut: true },
              reviews: reviewsFlat,
            },
            {
              cta: {
                description: "Timed out, checks still running:",
                commands: [
                  {
                    command: `check --watch --timeout ${opts.timeout * 2}`,
                    description: "Retry with longer timeout",
                  },
                ],
              },
            },
          );
        }

        await new Promise<void>((r) => setTimeout(r, opts.interval * 1000));
      }
    }

    // Default: fetch both in parallel
    const [{ status, flat: ciFlat }, reviewData] = await Promise.all([
      getCISection(ctx, prNumber, headSha),
      getReviewsList(ctx, prNumber, filterOpts),
    ]);

    const reviewsFlat = formatReviewsSection(reviewData.comments);

    return c.ok(
      { ci: ciFlat, reviews: reviewsFlat },
      {
        cta:
          status.pending > 0
            ? {
                description: "Checks still running:",
                commands: [{ command: "check --watch", description: "Watch until complete" }],
              }
            : status.failing > 0
              ? {
                  description: "Checks failing:",
                  commands: [
                    { command: "check --unresolved", description: "Show unresolved reviews" },
                  ],
                }
              : undefined,
      },
    );
  },
};
