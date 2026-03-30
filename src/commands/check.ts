import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import { fetchPRMergeState, type PRMergeState, type CIStatus } from "../github/index.js";
import { getCISection } from "./ci.js";
import {
  getReviewsList,
  getReviewDetail,
  postReply,
  formatReviewsSection,
  commentSchema,
} from "./reviews.js";

function buildPRSection(
  mergeState: PRMergeState,
  ciStatus: CIStatus,
  unresolvedCount: number,
): { state: string; mergeable: string; ready: boolean } {
  return {
    state: mergeState.state,
    mergeable: mergeState.mergeableState,
    ready:
      mergeState.state === "open" &&
      mergeState.mergeableState === "clean" &&
      ciStatus.failing === 0 &&
      ciStatus.pending === 0 &&
      unresolvedCount === 0,
  };
}

function buildSyncCTA(
  mergeableState: string,
  prNumber: number,
): { description: string; commands: { command: string; description: string }[] } | undefined {
  if (mergeableState === "dirty") {
    return {
      description: "PR has merge conflicts:",
      commands: [{ command: `sync ${prNumber}`, description: "Show conflict details" }],
    };
  }
  if (mergeableState === "behind") {
    return {
      description: "PR is behind base branch:",
      commands: [{ command: `sync ${prNumber}`, description: "Sync with base branch" }],
    };
  }
  return undefined;
}

interface CheckCommandContext {
  var: { ctx: Context };
  args: { pr?: number };
  options: {
    watch: boolean;
    interval: number;
    timeout: number;
    unresolved: boolean;
    unanswered: boolean;
    botsOnly: boolean;
    humansOnly: boolean;
    reply?: string;
    resolve: boolean;
    detail?: number;
  };
  ok: (data: Record<string, unknown>, meta?: Record<string, unknown>) => unknown;
  error: (data: { message: string }) => unknown;
}

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
    pr: z
      .object({
        state: z.string().describe("open | closed | merged"),
        mergeable: z
          .string()
          .describe("Merge state: clean, dirty, blocked, behind, unstable, unknown, has_hooks"),
        ready: z
          .boolean()
          .describe(
            "true when state=open, mergeableState=clean, all CI passing, zero unresolved reviews",
          ),
      })
      .optional(),
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
  async run(c: CheckCommandContext) {
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
        // Fetch merge state first — CI results are irrelevant until PR is syncable
        const mergeState = await fetchPRMergeState(
          ctx.repoInfo.owner,
          ctx.repoInfo.repo,
          prNumber,
          ctx.token,
          ctx.proxyFetch,
        );

        const syncCTA = buildSyncCTA(mergeState.mergeableState, prNumber);
        if (syncCTA) {
          const prSection = buildPRSection(mergeState, { failing: 0, pending: 0 } as CIStatus, 0);
          return c.ok({ pr: prSection }, { cta: syncCTA });
        }

        const [{ status, flat: ciFlat }, reviewData] = await Promise.all([
          getCISection(ctx, prNumber, headSha),
          getReviewsList(ctx, prNumber, filterOpts),
        ]);

        const reviewsFlat = formatReviewsSection(reviewData.comments);
        const unresolvedCount = reviewData.comments.filter(
          (cm) => !(cm.isResolved || cm.hasHumanReply),
        ).length;
        const prSection = buildPRSection(mergeState, status, unresolvedCount);

        if (status.failing === 0 && status.pending === 0) {
          return c.ok({
            pr: prSection,
            ci: { ...ciFlat, allPassing: true },
            reviews: reviewsFlat,
          });
        }

        if (status.failing > 0 && status.pending === 0) {
          return c.ok(
            {
              pr: prSection,
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
              pr: prSection,
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

    // Default: fetch all in parallel
    const [mergeState, { status, flat: ciFlat }, reviewData] = await Promise.all([
      fetchPRMergeState(ctx.repoInfo.owner, ctx.repoInfo.repo, prNumber, ctx.token, ctx.proxyFetch),
      getCISection(ctx, prNumber, headSha),
      getReviewsList(ctx, prNumber, filterOpts),
    ]);

    const reviewsFlat = formatReviewsSection(reviewData.comments);
    const unresolvedCount = reviewData.comments.filter(
      (cm) => !(cm.isResolved || cm.hasHumanReply),
    ).length;
    const prSection = buildPRSection(mergeState, status, unresolvedCount);

    const defaultSyncCTA = buildSyncCTA(mergeState.mergeableState, prNumber);
    return c.ok(
      { pr: prSection, ci: ciFlat, reviews: reviewsFlat },
      {
        cta:
          defaultSyncCTA ??
          (status.pending > 0
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
              : undefined),
      },
    );
  },
};
