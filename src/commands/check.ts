import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import {
  fetchPRMergeState,
  updatePRBranch,
  type PRMergeState,
  type CIStatus,
} from "../github/index.js";
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
  hint: "Combines CI checks and review comments. Use --reply and --detail for review actions. With --watch, returns immediately when there is actionable work (CI failures, unresolved reviews), only polls while CI is pending with nothing to do.",
  args: z.object({
    pr: z.coerce.number().optional().describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    watch: z
      .boolean()
      .default(false)
      .describe("Poll until actionable: returns on CI failure, unresolved reviews, or all passing"),
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
        synced: z
          .boolean()
          .optional()
          .describe("true when bellwether triggered an update-branch to sync with base"),
        conflict: z
          .object({
            base: z.string().describe("Base branch that conflicts with the PR head"),
            resolution: z.string().describe("Git command to resolve the conflict locally"),
          })
          .optional()
          .describe("Present when mergeableState=dirty; provides actionable resolution steps"),
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
    const { prNumber } = await resolvePR(ctx, c.args.pr);
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

    // Watch mode — poll until there is actionable work or CI reaches terminal state.
    // Returns immediately when: CI fails, unresolved reviews exist, merge conflict,
    // all passing, or timeout. Only keeps polling when CI is pending AND there is
    // nothing actionable (no failures, no unresolved reviews).
    if (opts.watch) {
      const start = Date.now();
      let syncAttempted = false;
      let pollCount = 0;
      while (true) {
        pollCount++;
        // Fetch merge state first so headSha is always current before CI fetch
        const mergeState = await fetchPRMergeState(
          ctx.repoInfo.owner,
          ctx.repoInfo.repo,
          prNumber,
          ctx.token,
          ctx.proxyFetch,
        );

        // Branch behind base — auto-sync once, then continue polling
        if (mergeState.mergeableState === "behind" && !syncAttempted) {
          syncAttempted = true;
          try {
            await updatePRBranch(
              ctx.repoInfo.owner,
              ctx.repoInfo.repo,
              prNumber,
              ctx.token,
              ctx.proxyFetch,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Failed to sync branch with base";
            return c.ok(
              {
                pr: {
                  state: mergeState.state,
                  mergeable: mergeState.mergeableState,
                  ready: false,
                  synced: false,
                },
              },
              {
                cta: {
                  description: "Sync failed:",
                  commands: [{ command: `sync ${prNumber}`, description: message }],
                },
              },
            );
          }
          // Brief pause so GitHub can enqueue the merge commit before next poll
          await new Promise<void>((r) => setTimeout(r, 5000));
          continue;
        }

        // Merge conflict — report immediately without fetching CI/reviews
        if (mergeState.mergeableState === "dirty") {
          return c.ok(
            {
              pr: {
                state: mergeState.state,
                mergeable: mergeState.mergeableState,
                ready: false,
                conflict: {
                  base: mergeState.baseBranch,
                  resolution: `git fetch origin && git merge origin/${mergeState.baseBranch} && git push`,
                },
              },
            },
            {
              cta: {
                description: "Merge conflict with base branch:",
                commands: [
                  {
                    command: `git fetch origin && git merge origin/${mergeState.baseBranch} && git push`,
                    description: "Merge base into PR branch to resolve",
                  },
                ],
              },
            },
          );
        }

        // Fetch CI (using current headSha) and reviews in parallel
        const [{ status, flat: ciFlat }, reviewData] = await Promise.all([
          getCISection(ctx, prNumber, mergeState.headSha),
          getReviewsList(ctx, prNumber, filterOpts),
        ]);

        const reviewsFlat = formatReviewsSection(reviewData.comments);
        const unresolvedCount = reviewData.comments.filter(
          (cm) => !(cm.isResolved || cm.hasHumanReply),
        ).length;
        const prSection = buildPRSection(mergeState, status, unresolvedCount);
        const prSectionWithSync = syncAttempted ? { ...prSection, synced: true } : prSection;

        // Terminal: all passing, no unresolved reviews
        if (status.failing === 0 && status.pending === 0 && unresolvedCount === 0) {
          return c.ok({
            pr: prSectionWithSync,
            ci: { ...ciFlat, allPassing: true },
            reviews: reviewsFlat,
          });
        }

        // Actionable: CI failures exist — return so caller can fix them
        if (status.failing > 0) {
          return c.ok(
            {
              pr: prSectionWithSync,
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

        // Actionable: unresolved reviews — return so caller can address them
        if (unresolvedCount > 0) {
          return c.ok(
            {
              pr: prSectionWithSync,
              ci: ciFlat,
              reviews: reviewsFlat,
            },
            {
              cta: {
                description: "Unresolved review comments:",
                commands: [
                  { command: "check --unresolved", description: "Show unresolved reviews" },
                ],
              },
            },
          );
        }

        // Nothing actionable, CI still pending — keep polling
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stderr.write(
          `[watch] poll ${pollCount} (${elapsed}s) — ${status.passing}/${status.total} passing, ${status.pending} pending, ${status.failing} failing\n`,
        );

        if (elapsed >= opts.timeout) {
          return c.ok(
            {
              pr: prSectionWithSync,
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

    // Default: fetch mergeState first for current headSha, then CI+reviews in parallel
    const mergeState = await fetchPRMergeState(
      ctx.repoInfo.owner,
      ctx.repoInfo.repo,
      prNumber,
      ctx.token,
      ctx.proxyFetch,
    );
    // Branch behind base — sync first; CI/reviews would be stale after sync
    if (mergeState.mergeableState === "behind") {
      try {
        await updatePRBranch(
          ctx.repoInfo.owner,
          ctx.repoInfo.repo,
          prNumber,
          ctx.token,
          ctx.proxyFetch,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to sync branch with base";
        return c.error({ message });
      }
      const refreshedMergeState = await fetchPRMergeState(
        ctx.repoInfo.owner,
        ctx.repoInfo.repo,
        prNumber,
        ctx.token,
        ctx.proxyFetch,
      );
      return c.ok(
        {
          pr: {
            state: refreshedMergeState.state,
            mergeable: refreshedMergeState.mergeableState,
            ready: false,
            synced: true,
          },
        },
        {
          cta: {
            description: "Branch synced with base — new CI run triggered:",
            commands: [{ command: "check --watch", description: "Watch new CI run" }],
          },
        },
      );
    }

    // Merge conflict — report without fetching CI/reviews
    if (mergeState.mergeableState === "dirty") {
      return c.ok(
        {
          pr: {
            state: mergeState.state,
            mergeable: mergeState.mergeableState,
            ready: false,
            conflict: {
              base: mergeState.baseBranch,
              resolution: `git fetch origin && git merge origin/${mergeState.baseBranch} && git push`,
            },
          },
        },
        {
          cta: {
            description: "Merge conflict with base branch:",
            commands: [
              {
                command: `git fetch origin && git merge origin/${mergeState.baseBranch} && git push`,
                description: "Merge base into PR branch to resolve",
              },
            ],
          },
        },
      );
    }

    const [{ status, flat: ciFlat }, reviewData] = await Promise.all([
      getCISection(ctx, prNumber, mergeState.headSha),
      getReviewsList(ctx, prNumber, filterOpts),
    ]);

    const reviewsFlat = formatReviewsSection(reviewData.comments);
    const unresolvedCount = reviewData.comments.filter(
      (cm) => !(cm.isResolved || cm.hasHumanReply),
    ).length;
    const prSection = buildPRSection(mergeState, status, unresolvedCount);

    return c.ok(
      { pr: prSection, ci: ciFlat, reviews: reviewsFlat },
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
