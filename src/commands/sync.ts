import { z } from "incur";
import { resolvePR, type Context } from "../context.js";
import { ghFetch, getRepoRoot } from "../github/index.js";
import {
  updatePRBranch,
  detectLocalConflicts,
  type FileConflict,
} from "../github/sync.js";

interface RawPRData {
  base: { ref: string };
  head: { sha: string };
  mergeable_state: string | null;
}

interface SyncCommandContext {
  var: { ctx: Context };
  args: { pr?: number };
  options: { detectConflicts: boolean };
  ok: (data: Record<string, unknown>, meta?: Record<string, unknown>) => unknown;
  error: (data: { message: string }) => unknown;
}

const conflictSchema = z.object({
  file: z.string(),
  count: z.number(),
  hunks: z.array(z.object({ ours: z.string(), theirs: z.string() })),
});

export const syncCommand = {
  description: "Sync PR branch with its base branch",
  hint: "Merges the base branch into the PR branch via GitHub API. When conflicts exist, reports them in a compact token-efficient format.",
  args: z.object({
    pr: z.coerce.number().optional().describe("PR number (auto-detects from branch)"),
  }),
  options: z.object({
    detectConflicts: z
      .boolean()
      .default(true)
      .describe("Detect and report conflict details when sync fails"),
  }),
  alias: {
    detectConflicts: "c",
  },
  usage: [
    {},
    { args: { pr: 123 } },
    { options: { detectConflicts: false } },
  ],
  output: z.object({
    synced: z.boolean().describe("Whether the branch was updated"),
    message: z.string().describe("Status message"),
    mergeableState: z.string().optional().describe("Current PR mergeable state"),
    conflicts: z
      .array(conflictSchema)
      .optional()
      .describe("Conflict hunks per file (only when sync fails due to conflicts)"),
  }),
  examples: [
    { description: "Sync current branch PR with its base" },
    { args: { pr: 123 }, description: "Sync PR #123" },
    { options: { detectConflicts: false }, description: "Sync without conflict analysis" },
  ],
  async run(c: SyncCommandContext) {
    const ctx: Context = c.var.ctx;
    const { prNumber } = await resolvePR(ctx, c.args.pr);

    const prResponse = await ghFetch(
      `https://api.github.com/repos/${ctx.repoInfo.owner}/${ctx.repoInfo.repo}/pulls/${prNumber}`,
      ctx.token,
      ctx.proxyFetch,
    );
    if (!prResponse.ok) {
      return c.error({ message: `Failed to fetch PR: ${prResponse.status}` });
    }
    const prData = (await prResponse.json()) as RawPRData;
    const baseBranch = prData.base.ref;
    const mergeableState = prData.mergeable_state ?? "unknown";

    if (mergeableState === "clean") {
      return c.ok({ synced: true, message: "PR is already up to date", mergeableState });
    }

    // Conflicts present — skip update-branch (it will 422) and report details
    if (mergeableState === "dirty") {
      const conflicts = c.options.detectConflicts ? getConflicts(baseBranch, prData.head.sha) : [];
      return c.ok(
        {
          synced: false,
          message: "PR has merge conflicts that must be resolved manually",
          mergeableState,
          ...(conflicts.length > 0 && { conflicts }),
        },
        conflicts.length > 0
          ? {
              cta: {
                description: `${conflicts.length} file(s) have conflicts. Resolve locally and push:`,
                commands: [
                  {
                    command: `git fetch origin && git rebase origin/${baseBranch}`,
                    description: "Rebase onto base branch and resolve conflicts",
                  },
                ],
              },
            }
          : undefined,
      );
    }

    // Attempt server-side update (handles "behind" and other states)
    const expectedHeadSha = prData.head.sha;
    const result = await updatePRBranch(
      ctx.repoInfo.owner,
      ctx.repoInfo.repo,
      prNumber,
      expectedHeadSha,
      ctx.token,
      ctx.proxyFetch,
    );

    if (result.updated) {
      return c.ok(
        { synced: true, message: result.message, mergeableState },
        {
          cta: {
            description: "Branch synced. Monitor CI:",
            commands: [{ command: "check --watch", description: "Watch until CI completes" }],
          },
        },
      );
    }

    // Update failed — try local conflict detection as fallback
    const conflicts = c.options.detectConflicts ? getConflicts(baseBranch, prData.head.sha) : [];
    return c.ok({
      synced: false,
      message: result.message,
      mergeableState,
      ...(conflicts.length > 0 && { conflicts }),
    });
  },
};

function getConflicts(baseBranch: string, prHeadSha: string): FileConflict[] {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    return [];
  }
  return detectLocalConflicts(baseBranch, repoRoot, prHeadSha);
}
